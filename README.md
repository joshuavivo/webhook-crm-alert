# Payment webhook → CRM → chat alert

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
4. **Retry each outbound call** with exponential backoff (200 ms, 400 ms, … capped at 2 s in `server.ts`). Errors
   marked permanent, like a 400, are not retried.
5. **Dead-letter on exhaustion.** The event, the failing step, the attempt count and the last
   error are recorded, and the webhook returns `202`. The event is ours now, and asking the
   provider to resend it would only create a second copy.
6. **Replay** a dead letter with `replayDeadLetter(eventId)`. Steps that already succeeded are
   skipped.

Amounts are integer cents end to end. A float amount is rejected at the door.

## Files

| File | What it does |
|---|---|
| `src/signature.ts` | Sign and verify, with timestamp tolerance and rotation. |
| `src/handler.ts` | The pipeline: verify, claim, steps, dead-letter, replay. |
| `src/retry.ts` | `withRetry` with exponential backoff; sleep is injected so tests run instantly. |
| `src/store.ts` | Event and dead-letter store interface, plus the in-memory version. |
| `src/clients.ts` | CRM and chat interfaces, plus fakes that can be scripted to fail. |
| `src/server.ts` | `node:http` server on `POST /webhooks/payments`, raw body, 256 KB limit. |
| `test/` | 18 tests, `node:test`. |

## Run it

Node 23.6 or newer runs TypeScript directly. There are no dependencies to install.

```sh
npm test
WEBHOOK_SECRET=dev_only npm start   # listens on :3000 with the in-memory fakes
```

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
- Steps run one after another and only one event type is handled. A queue and workers would
  replace the inline calls at higher volume.

Joshua Vivo · [shadowvivo.com](https://shadowvivo.com)
