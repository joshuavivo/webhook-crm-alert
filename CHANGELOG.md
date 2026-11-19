# Changelog

Notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0]

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

## [0.1.0]

### Added
- Payment webhook → CRM upsert → chat alert, with signature verification
  (timestamp + HMAC, constant-time, rotation), an atomic idempotent claim, retries
  with exponential backoff, a dead-letter record with replay, and a 256 KB raw-body
  HTTP server. 18 tests, no runtime dependencies.
