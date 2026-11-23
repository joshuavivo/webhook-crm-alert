# Payment webhook → CRM → chat alert

**When a "payment received" alert goes missing, nobody follows up with the customer who just
paid. When it fires twice, two people chase the same customer.** This sample makes the alert
and the CRM update happen once under provider retries and failed outbound calls (with the
exceptions listed below), and when something fails, it lands in a dead-letter list
(`store.deadLetters()`) that a person or a script can replay (`replayDeadLetter`); there is no
UI or route for it. With the default in-memory store, three gaps remain: a crash
mid-processing, a restart, and a chat post whose reply is lost. The [Postgres
path](#the-postgres-path), built on
[exactly-once-webhooks](https://github.com/joshuavivo/exactly-once-webhooks) and an outbox,
closes the first two, provided something runs its `drainPending()` on a schedule. The third
remains on both paths; see Limits.

A payment provider sends a webhook when a charge succeeds. Someone wants the customer in the
CRM and a message in the team channel. That part is easy. The hard part is what happens when
things go wrong:

- **Anyone can POST to a public URL.** A request with a missing or wrong signature has to be
  refused before it touches anything.
- **Providers retry.** The same event can arrive twice, or twice at the same moment. A retry
  must not create a second CRM write or a second alert.
- **Outbound calls fail.** The CRM times out, the chat API returns a 503. Those calls should be
  retried with backoff, and when retries run out the event should land somewhere a person can
  see it and replay it. It should not disappear into a log line.
- **Half-finished work.** If the CRM write succeeded and the alert failed, a replay must post
  the alert *without* writing to the CRM again.

I built this sample to show how I handle those four cases. The CRM and chat clients are interfaces
with in-memory fakes. They are shaped like a typical contacts API and a typical incoming-webhook
chat API, but this is not any vendor's code and it needs no accounts or keys.

Text the customer typed (their name, their email) is made safe before it goes into the team
chat: one line, no mention or link syntax (`&<>` escaped), and no `@everyone`-style mentions,
so a name typed at checkout can't ping the channel or add a fake "Payment received" line.
Ordinary formatting such as `*bold*` still passes through, and a chat app may still turn a
bare URL in a name into a link. An email at a domain starting with `here`, `everyone` or
`channel` is shown with a hidden zero-width character after the `@`, so a copy of it won't
paste cleanly; that is the price of `x@everyone.com` not pinging the channel.

## How it works

1. **Verify.** The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256>` over
   `"<t>.<raw body>"`. The check uses the exact bytes received, compares in constant time,
   rejects anything older than five minutes, and accepts several `v1` values so a secret can be
   rotated. A rejected request does not claim the event id.
2. **Claim the event id.** If the id has been seen before, the response is `200 duplicate` and
   nothing runs. The check and the insert happen together, so two simultaneous deliveries
   cannot both win. (In a database this is a unique key with `INSERT … ON CONFLICT DO NOTHING`.)
3. **Run the steps in order:** CRM upsert, then chat alert. Each step that succeeds is recorded
   against the event.
4. **Retry each outbound call** with exponential backoff. `server.ts` allows 4 attempts, so
   a call that keeps failing waits 200 ms, 400 ms, then 800 ms between tries. Each wait is
   capped at `maxDelayMs` (2 s there), which only matters with more attempts. Errors marked
   permanent, like a 400, are not retried.
5. **Dead-letter on exhaustion.** The event, the failing step, the attempt count and the last
   error are recorded, and the webhook returns `202`. The event is ours now, and asking the
   provider to resend it would only create a second copy.
6. **Replay** a dead letter with `replayDeadLetter(eventId)`. Steps that already succeeded are
   skipped.

Amounts are integers in the currency's smallest unit end to end (cents for USD, whole yen for JPY, fils for KWD). A float, zero, negative or out-of-range amount, a currency that isn't three letters, an email that isn't shaped like one, a non-text or overlong name, and a timestamp no clock can show are rejected at the door with a 400, before the event id is claimed, so impossible data neither posts a bogus alert nor gets retried into the dead letter.

## The Postgres path

`src/pg-pipeline.ts` is the same handler with the record of handled events in Postgres. It is
a library function with tests; `server.ts` still runs the memory path. Three terms:
- **claim**: recording an event id as taken, so a second delivery of it does nothing;
- **outbox**: a table of calls still to make, written in the same transaction as the event;
- **lease**: "a sender has this outbox row until time T", plus a token that only that sender holds.

How one delivery goes:

1. **One transaction, database writes only.** The claim goes through
   [exactly-once-webhooks](https://github.com/joshuavivo/exactly-once-webhooks)' Postgres store.
   The event's idempotency key, its event row and one outbox row per step (`crm_upsert`,
   `chat_alert`) commit together, or none of them do. No outbound call happens inside it.
2. **Then the calls are sent from the outbox,** in order, with the same retry, backoff and
   dead-letter rules as the memory path. The chat alert is not sent until the CRM row is sent.
   A sender can only mark a row sent or dead-lettered while its lease token is still current,
   so a sender that stalls past its lease and wakes up late changes nothing.
3. **`drainPending()` sends whatever was committed but never sent,** for example after a crash
   between the commit and the calls. Nothing in this repo schedules it: run it from a cron or a
   worker, or set `drain: "deferred"` and let the worker do all the sending.

What that changes, compared with the memory path:
- **A crash before the commit** leaves nothing behind: no key, no event row, no outbox rows.
  The provider's retry processes the event from the start.
- **A crash after the commit** leaves the outbox rows. The calls go out when `drainPending()`
  next runs (after the dead sender's lease expires, if it died mid-call).
- **A restart** changes nothing. The record is in Postgres, so a redelivery is still refused.
- **Concurrent deliveries** produce one event row and one outbox row per step. The database's
  primary key enforces it, so it holds across instances. In the tests, 12 concurrent deliveries
  of one event, spread over three pipelines with their own connection pools, leave
  `SELECT count(*) FROM crm_outbox WHERE event_id = $1` at 2, and each call is made once.

What it doesn't change: the outbound calls are still at-least-once. A sender that dies after a
call went out, but before marking the row sent, has that call repeated once its lease runs out.
The CRM upsert is keyed on email, so a repeat is harmless. A repeated chat post shows the alert
twice. That is the same gap as a lost chat response, below.

Why a library for the claim, when `INSERT … ON CONFLICT DO NOTHING` on `crm_events` would also
de-duplicate? For this sample it would. The library is built on that same statement and adds
tested handling around it: the second delivery gets the stored result, the wait for another
delivery's transaction has a time limit, and a connection whose ROLLBACK failed is dropped
instead of reused. Using it here is also deliberate: it gives the library a user outside its own
repo, with tests that hold it to its claims.

The schema is in [`schema.sql`](schema.sql). Load it after exactly-once-webhooks' own
`schema.sql`, which creates the `idempotency_keys` table.

## Files

| File | What it does |
|---|---|
| `src/signature.ts` | Sign and verify, with timestamp tolerance and rotation. |
| `src/handler.ts` | The pipeline: verify, claim, steps, dead-letter, replay. |
| `src/retry.ts` | `withRetry` with exponential backoff; sleep is injected so tests run instantly. |
| `src/store.ts` | Event and dead-letter store interface, plus the in-memory version. |
| `src/pg-pipeline.ts` | The Postgres path: claim + outbox in one transaction, then the calls. |
| `schema.sql` | Tables for the Postgres path. |
| `src/clients.ts` | CRM and chat interfaces, plus fakes that can be scripted to fail. |
| `src/server.ts` | `node:http` server on `POST /webhooks/payments`, raw body, 256 KB limit. |
| `test/` | 45 tests, `node:test`. 17 of them need Postgres. |

## Run it

Node 22.18 or newer runs the TypeScript directly. The Postgres path needs Postgres 13 or newer.
The memory path imports nothing outside Node. `exactly-once-webhooks` is a package dependency
that only the Postgres path loads; it is installed from its GitHub release (it isn't on the npm
registry yet). The Postgres tests use `pg`, a dev dependency; the pipeline itself takes any
pool with `connect()` and `query()`.

```sh
npm test                            # node:test, no install needed; the Postgres tests skip
npm ci && npm run typecheck         # strict typecheck (CI runs this on Node 22 and 24)
DATABASE_URL=postgres://... npm test   # also runs the 17 Postgres tests (after npm ci)
WEBHOOK_SECRET=dev_only npm start   # listens on :3000 with the in-memory fakes
```

CI runs every test against a Postgres 16 service, and fails rather than skips if the database
is missing.

How the pipeline stays correct under failure — the crash window, why the chat alert
is deliberately the last step, the dead-letter/202 reasoning, and a failure model
with what this does **not** handle — is in [`DESIGN.md`](DESIGN.md).

## What the tests prove

- A bad signature, a tampered body, a missing header and a stale timestamp are each rejected,
  and none of them writes anything.
- A replayed event writes nothing, and two concurrent deliveries of one event do the work once.
- A transient failure is retried on the expected backoff schedule and then succeeds.
- A call that keeps failing is retried, then dead-lettered with its step, attempts and error.
  A permanent error is dead-lettered on the first try.
- When the CRM write succeeds and the alert fails, neither a provider retry nor a manual replay
  repeats the CRM write. The replay posts the alert and marks the dead letter replayed.
- A CRM failure stops the pipeline before an alert is posted.
- On Postgres:
  - 12 concurrent deliveries over three pipelines leave one event row and one outbox row per
    step, and each call is made once. Two senders draining the same event make each call once.
  - A failed COMMIT leaves no key, event row or outbox rows, and the retry processes the event.
    A COMMIT whose reply was lost makes the retry a duplicate, and `drainPending()` sends the
    calls. (Both crashes are simulated by a pool that fails at COMMIT.)
  - A new pipeline on the same database still refuses a duplicate.
  - A sender that stalls past its 50 ms lease can't overwrite the sender that took over, whether
    its late call fails (no dead letter appears) or succeeds (it doesn't go on to send the
    alert); the outbox ends `sent` either way. A step held under a live lease blocks the
    next step (set by rewriting `lease_until` in the test).
  - A failed send after the commit is reported to `onDrainError`, answered 202, and sent later.
    An event with a dead-lettered step waits for its replay. Dead letters and replays work as on
    the memory path.

I checked that these tests can fail. I removed the step skip, the de-duplication, the signature
check and the backoff one at a time, and each removal turned the matching tests red. For the
Postgres path I did the same by hand twice: a version that commits the claim in its own
transaction before writing the event fails the crash test (the claim survives the crash, so the
retry is refused and the event is never processed), and a version without the lease-token check
fails the stalled-sender test.

## Limits

- The default store is in memory, so a restart forgets which events were handled. The Postgres
  path keeps that record in the database.
- On the memory path, if the process dies between claiming an event and finishing it, the event
  stays in `processing`, and a provider retry is acknowledged as a duplicate. On the Postgres
  path the claim and the work commit together, and unsent calls are picked up by
  `drainPending()`.
- On the Postgres path the lease (`leaseMs`, default 60 s) should be longer than a call plus all
  its retries. If it runs out mid-call, a second sender takes the step over and repeats the
  call. The token check stops the late sender from changing the outcome, but the call itself
  has gone out twice.
- `drainPending()` reads every due event in one query, with no limit, and sends them one at a
  time. A production worker would take a bounded batch (`LIMIT` with `FOR UPDATE SKIP LOCKED`)
  and send events in parallel.
- If the CRM write succeeds but the response is lost, the retry calls upsert again. That is
  safe because an upsert keyed on email is idempotent on the CRM side. A non-idempotent call
  would need its own idempotency key.
- If the chat post goes through but its reply is lost (a timeout), the retry posts it again and
  the alert appears twice. The chat step has no idempotency key; a real version would add one.
- A signed event that fails validation (say a $0 payment) gets a 400 and is not stored. The
  provider keeps retrying it and shows it as failing in its own dashboard; this sample keeps no
  record of it. A real version would also log or store rejected payloads.
- Replaying an old dead letter after a newer payment for the same customer sets the CRM's last
  payment back to the older one: the upsert carries no event time to compare. A real version
  sends `created` and lets the CRM keep the newest.
- Emails are passed as received, so `Ada@Example.com` and `ada@example.com` are two contacts,
  and the CRM gets the amount without its currency.
- Steps run one after another and only one event type is handled. A queue and workers would
  replace the inline calls at higher volume.

(These are expanded, with the failure model, in [`DESIGN.md`](DESIGN.md).)

## Credits

Architected and directed by [Joshua Vivo](https://github.com/joshuavivo) ([Shadow Vivo LLC](https://shadowvivo.com)), built with AI assistance (Claude). The design and the judgment are mine.
