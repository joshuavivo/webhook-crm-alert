# Changelog

Notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **A Postgres path (`src/pg-pipeline.ts`, `schema.sql`).** The claim goes through
  [exactly-once-webhooks](https://github.com/joshuavivo/exactly-once-webhooks)' Postgres store,
  and the event row and one outbox row per step commit in the same transaction. Nothing
  outbound happens inside it; the calls are sent from the outbox afterwards, in order, under a
  lease whose token fences late writers, with the existing retry and dead-letter rules. This
  closes two of the three gaps the README listed, provided `drainPending()` runs on a
  schedule (this repo provides it but doesn't schedule it): a crash mid-processing (the claim
  and the work commit together or not at all) and a restart (the record is in Postgres). A
  chat post whose reply is lost can still repeat; that gap stays in Limits. 17 tests against
  a real Postgres, run in CI with no skips. The memory path is unchanged and imports nothing
  outside Node.

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
  add a fake "Payment received" line. Customer text is now one line (every line break,
  including U+2028/2029 and C1 controls, becomes a space), with `&<>` escaped and every mass
  mention broken, in the email too (a valid address like `x@everyone.com` would otherwise
  ping; the cost is a hidden character in such an address). A non-text or overlong name and an email that isn't shaped like
  one (`"@"`) are rejected at the door; they used to post `[object Object] <@>`.
- **The email is no longer wrapped in `<...>` in the alert.** The alert read
  `Name <email>`, and an email like `!channel|a@b.co` passes validation, so the message
  contained `<!channel|a@b.co>`, Slack's channel-mention token. It now reads
  `Name (email)`. Found by a pre-push AI review.
- **Three-decimal currencies in the alert.** 5120 KWD minor units was shown as
  "51.20 KWD" instead of 5.120. BHD, JOD, KWD, OMR and TND now use three decimals.

### Changed
- **`exactly-once-webhooks` is installed from npm** (`^0.10.1`) instead of the v0.10.0
  release tarball URL, now that it is on the registry. The README said it was not.
- **README names the signature header** (`payment-signature`) and says the timestamp
  tolerance is five minutes in either direction, which is what `src/signature.ts` checks.
- The README's first screen now says where a failed event goes (a dead-letter list
  that code can replay; there is no UI) and counts three gaps, not two: a restart
  is one, since handled events are remembered in memory. README Limits and
  DESIGN.md now also cover an old event replayed after a newer one (the CRM's last
  payment goes backwards), signed events that fail validation (400, not stored),
  and emails compared case-sensitively.

## [0.2.1] - 2026-11-20

Fixes from an AI review.

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
