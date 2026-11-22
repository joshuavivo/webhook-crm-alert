# Changelog

Notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **Bad data is rejected at the door.** Zero, negative and out-of-range amounts, a
  negative timestamp and a non-letter currency were accepted and posted a "Payment
  received" alert. `created` was only checked to be a number, so `created: 1e15`
  passed, then `new Date(...)` threw inside the CRM step: the event was retried,
  dead-lettered with a 202, and every replay failed the same way. `created` must now be a positive Unix time a date can hold, `amount_cents` a
  positive safe integer, and `currency` three letters; anything else is a 400 at the
  door and the event id is not claimed.
- **Zero-decimal currencies in the alert.** `formatMoney` always divided by 100, so
  1000 JPY was announced as "10.00 JPY". Currencies with no minor unit (Stripe's
  zero-decimal list: JPY, KRW, VND and others) are now shown as whole units.
- **Customer text can't forge or ping in the alert.** A name typed at checkout went into
  the chat verbatim, so `<!channel> @everyone` plus a newline could ping the channel and
  add a fake "Payment received" line. Customer text is now one line, markup-escaped, with
  mass mentions broken. A non-text or overlong name and an email that isn't shaped like
  one (`"@"`) are rejected at the door; they used to post `[object Object] <@>`.
- **Three-decimal currencies in the alert.** 5120 KWD minor units was shown as
  "51.20 KWD" instead of 5.120. BHD, JOD, KWD, OMR and TND now use three decimals.

## [0.2.1] - 2026-11-20

Fixes from an independent review.

### Fixed
- **Signature check over the raw bytes.** The server decoded the body as UTF-8
  before computing the HMAC, so a validly signed body containing invalid UTF-8
  (e.g. a 0xff byte) was rejected with 401. The Buffer now goes to
  `verifySignature` unchanged and is decoded only for `JSON.parse`. A new HTTP
  test signs such a body independently of `sign()` and expects 200.
- The malformed-payload test now asserts that neither rejected event id
  (`evt_003`, `evt_004`) is claimed; it only checked the first.
- README: the backoff schedule in `server.ts` is 200/400/800 ms (4 attempts);
  the 2 s cap it mentioned is never reached there.
- `package.json` version brought in line with this changelog (it still said
  0.1.0 after the 0.2.0 entry).

### Added
- `Makefile` (`make check`, `make start`) and weekly Dependabot update PRs,
  landed after the 0.2.0 entry was written.

## [0.2.0] - 2026-11-19

### Added
- **Type checking.** A `tsconfig.json` under `strict`, a `typecheck` script, and
  TypeScript + `@types/node` as dev dependencies. The types were previously only
  stripped at runtime and never verified; CI now type-checks them.
- `DESIGN.md` — the pipeline diagram, the exactly-once-effects model, the crash
  window and why step order (idempotent first, non-idempotent last) is deliberate,
  the dead-letter/202 reasoning, and a failure model with an explicit
  "what this does NOT handle" section.
- `SECURITY.md` — a private disclosure channel.

### Changed
- CI runs on a **Node 22 and 24 matrix** (was Node 24 only) and now runs
  `npm run typecheck` before the tests.
- `engines.node` lowered to `>=22.18.0` (the first release with unflagged
  TypeScript type-stripping), matching the matrix.

## [0.1.0] - 2026-11-15

### Added
- Payment webhook → CRM upsert → chat alert, with signature verification
  (timestamp + HMAC, constant-time, rotation), an atomic idempotent claim, retries
  with exponential backoff, a dead-letter record with replay, and a 256 KB raw-body
  HTTP server. 18 tests, no runtime dependencies.
