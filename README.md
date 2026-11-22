# Payment webhook → CRM → chat alert

**When a "payment received" alert goes missing, nobody follows up with the customer who just
paid. When it fires twice, two people chase the same customer.** This sample makes the alert
and the CRM update happen once under provider retries and failed outbound calls, and when
something fails, it lands in a dead-letter list (`store.deadLetters()`) that a person or a
script can replay (`replayDeadLetter`); there is no UI or route for it. (Three gaps remain: a
crash mid-processing, a chat post whose reply is lost, and a restart, because the record of
handled events is in memory; see Limits.)

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

## Files

| File | What it does |
|---|---|
| `src/signature.ts` | Sign and verify, with timestamp tolerance and rotation. |
| `src/handler.ts` | The pipeline: verify, claim, steps, dead-letter, replay. |
| `src/retry.ts` | `withRetry` with exponential backoff; sleep is injected so tests run instantly. |
| `src/store.ts` | Event and dead-letter store interface, plus the in-memory version. |
| `src/clients.ts` | CRM and chat interfaces, plus fakes that can be scripted to fail. |
| `src/server.ts` | `node:http` server on `POST /webhooks/payments`, raw body, 256 KB limit. |
| `test/` | 27 tests, `node:test`. |

## Run it

Node 22.18 or newer runs the TypeScript directly, so the app and tests have **no
runtime dependencies**. Type-checking uses TypeScript as a dev dependency.

```sh
npm test                            # node:test, no install needed
npm ci && npm run typecheck         # strict typecheck (CI runs this on Node 22 and 24)
WEBHOOK_SECRET=dev_only npm start   # listens on :3000 with the in-memory fakes
```

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

I checked that these tests can fail. I removed the step skip, the de-duplication, the signature
check and the backoff one at a time, and each removal turned the matching tests red.

## Limits

- The store is in memory. A real deployment puts it in a database with a unique key on the
  event id, so the claim survives restarts and works across instances.
- If the process dies between claiming an event and finishing it, the event stays in
  `processing`, and a provider retry will be acknowledged as a duplicate. A real version needs a
  lease: reclaim `processing` rows older than a timeout.
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
