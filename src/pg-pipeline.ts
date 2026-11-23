// The Postgres path: the same webhook, with the record of handled events in Postgres and
// the outbound calls sent from an outbox (a table of calls still to make).
//
// One delivery commits, in one transaction run by exactly-once-webhooks' Postgres store:
// the event's idempotency key, its event row, and one outbox row per outbound step. No
// outbound call happens inside that transaction. If the process dies before COMMIT,
// nothing was recorded and the provider's retry processes the event from the start. If
// it dies after COMMIT, the outbox rows are still there, and `drainPending()` sends them
// when something runs it.
//
// The outbound calls themselves stay at-least-once: a sender that dies after a call went
// out but before marking the row sent will have that call repeated. The CRM upsert is
// keyed on email, so a repeat is harmless; a repeated chat post shows the alert twice.
import { createPostgresStore, type Pool, type PoolClient, type Queryable } from "exactly-once-webhooks";
import type { ChatClient, CrmClient } from "./clients.ts";
import { PermanentError } from "./clients.ts";
import { HANDLED, STEPS, checkRequest, performStep, type HandlerResult, type PaymentEvent } from "./handler.ts";
import { RetriesExhausted, errorMessage, withRetry, type RetryOptions } from "./retry.ts";
import type { DeadLetter, Step } from "./store.ts";

export type PgDeps = {
  secret: string;
  crm: CrmClient;
  chat: ChatClient;
  pool: Pool;
  retry: Omit<RetryOptions, "isRetryable">;
  alertChannel: string;
  now: () => Date;
  /** "inline" (default) sends the outbox right after the commit, in the request.
   *  "deferred" only commits and answers 202; a worker calls drainPending(). */
  drain?: "inline" | "deferred";
  /** How long a sender holds an outbox row while calling out, in ms. Should be longer
   *  than the slowest call plus all its retries: when it runs out, another sender takes
   *  the row and repeats the call. Default 60000. */
  leaseMs?: number;
  /** Called when sending an event's calls fails for a reason other than the calls
   *  themselves (the database, say). The event stays queued. Default: console.error. */
  onDrainError?: (err: unknown, eventId: string) => void;
};

/** Where an event's outbound calls stand. "in_progress": another sender holds a step,
 *  or took it over from this one. */
export type DrainStatus = "done" | "dead_lettered" | "in_progress";

export function createPostgresPipeline(deps: PgDeps) {
  const leaseMs = deps.leaseMs ?? 60_000;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new Error(`leaseMs must be a positive integer, got ${String(deps.leaseMs)}`);
  }
  const store = createPostgresStore(deps.pool);
  const retryOpts: RetryOptions = { ...deps.retry, isRetryable: (e) => !(e instanceof PermanentError) };
  const onDrainError = deps.onDrainError ?? ((err, id) => console.error(`drain failed for ${id}:`, err));
  // Reporting must never break draining or turn a committed event into a 500.
  const report = (err: unknown, eventId: string) => {
    try {
      onDrainError(err, eventId);
    } catch {
      /* ignored on purpose */
    }
  };

  async function handleWebhook(rawBody: string | Buffer, signatureHeader: string | undefined): Promise<HandlerResult> {
    const checked = checkRequest(rawBody, signatureHeader, deps.secret, deps.now());
    if ("status" in checked) return checked;
    const event = checked.event;
    const handled = event.type === HANDLED;

    // Database writes only. The idempotency key, the event row and the outbox rows
    // commit together, or (on any error, or a crash before COMMIT) none of them do.
    const outcome = await store.run(event.id, async (tx: Queryable) => {
      await tx.query("INSERT INTO crm_events (event_id, type, payload, received_at) VALUES ($1, $2, $3, $4)", [
        event.id,
        event.type,
        JSON.stringify(event),
        deps.now().toISOString(),
      ]);
      if (!handled) return "ignored";
      for (const step of STEPS) {
        await tx.query("INSERT INTO crm_outbox (event_id, step) VALUES ($1, $2)", [event.id, step]);
      }
      return "queued";
    });

    if (outcome.status === "duplicate") return { status: 200, body: { received: true, duplicate: true } };
    if (outcome.result === "ignored") return { status: 200, body: { received: true, ignored: event.type } };
    if (deps.drain === "deferred") return { status: 202, body: { received: true, status: "queued" } };

    // The event is committed; from here on a failure only delays the calls. Answer 202 so
    // the provider doesn't resend work we already hold; drainPending() finishes it.
    let status: DrainStatus | "queued";
    try {
      status = await drainEvent(event.id);
    } catch (err) {
      report(err, event.id);
      status = "queued";
    }
    return { status: status === "done" ? 200 : 202, body: { received: true, status } };
  }

  /** Send an event's outbox rows in order. A step already sent is skipped. */
  async function drainEvent(eventId: string): Promise<DrainStatus> {
    const loaded = await query("SELECT payload FROM crm_events WHERE event_id = $1", [eventId]);
    if (loaded.rows.length === 0) throw new Error(`unknown event ${eventId}`);
    const event = loaded.rows[0].payload as PaymentEvent;
    if (event.type !== HANDLED) return "done"; // an ignored type has nothing to send

    for (const step of STEPS) {
      // Take the row: pending, or sending under a lease that has run out (its sender died
      // or stalled). Every take gets a new token.
      const taken = await query(
        `UPDATE crm_outbox
         SET status = 'sending', lease_until = now() + make_interval(secs => $3), lease_token = gen_random_uuid()
         WHERE event_id = $1 AND step = $2
           AND (status = 'pending' OR (status = 'sending' AND lease_until < now()))
         RETURNING lease_token`,
        [eventId, step, leaseMs / 1000],
      );
      if (taken.rows.length === 0) {
        const cur = await query("SELECT status FROM crm_outbox WHERE event_id = $1 AND step = $2", [eventId, step]);
        const st = cur.rows[0]?.status;
        if (st === "sent") continue;
        if (st === "dead_lettered") return "dead_lettered";
        // sending: another sender holds it, so the next step waits. pending: it was reset
        // (a replay) between our take and this read; the replay sends it.
        if (st === "sending" || st === "pending") return "in_progress";
        throw new Error(`no outbox row for ${eventId}/${step}`);
      }
      const token = taken.rows[0].lease_token as string;

      // No transaction is open during the call: the row is held by its lease, not a lock.
      try {
        await withRetry(() => performStep(step, event, deps), retryOpts);
      } catch (err) {
        const attempts = err instanceof RetriesExhausted ? err.attempts : 1;
        const cause = err instanceof RetriesExhausted ? err.lastError : err;
        return (await deadLetter(eventId, step, token, attempts, errorMessage(cause))) ? "dead_lettered" : "in_progress";
      }
      // Only while the token is still ours: if the lease ran out and another sender took
      // the row, that sender owns the outcome, and this one stops here.
      const marked = await query(
        `UPDATE crm_outbox SET status = 'sent', sent_at = now(), lease_until = NULL, lease_token = NULL
         WHERE event_id = $1 AND step = $2 AND status = 'sending' AND lease_token = $3
         RETURNING step`,
        [eventId, step, token],
      );
      if (marked.rows.length === 0) return "in_progress";
    }
    return "done";
  }

  /** Send everything still unsent: committed events whose sender never ran, died or
   *  stalled past its lease. Events with a dead-lettered step wait for a replay.
   *  Run it on a schedule. Returns how each event ended up; one event's failure is
   *  reported to onDrainError and doesn't stop the others. */
  async function drainPending(): Promise<Record<string, DrainStatus | "error">> {
    const due = await query(
      `SELECT DISTINCT o.event_id FROM crm_outbox o
       WHERE (o.status = 'pending' OR (o.status = 'sending' AND o.lease_until < now()))
         AND NOT EXISTS (SELECT 1 FROM crm_outbox d WHERE d.event_id = o.event_id AND d.status = 'dead_lettered')`,
    );
    const out: Record<string, DrainStatus | "error"> = {};
    for (const r of due.rows) {
      const id = r.event_id as string;
      try {
        out[id] = await drainEvent(id);
      } catch (err) {
        report(err, id);
        out[id] = "error";
      }
    }
    return out;
  }

  async function deadLetters(): Promise<DeadLetter[]> {
    const r = await query("SELECT event_id, step, attempts, error, at, replayed FROM crm_dead_letters ORDER BY id");
    return r.rows.map((x) => ({
      eventId: x.event_id as string,
      step: x.step as Step,
      attempts: x.attempts as number,
      error: x.error as string,
      at: new Date(x.at as string).toISOString(),
      replayed: x.replayed as boolean,
    }));
  }

  /** Re-send a dead-lettered event. Steps that were already sent are skipped. */
  async function replayDeadLetter(eventId: string): Promise<DrainStatus> {
    await inTransaction(async (c) => {
      const reset = await c.query(
        "UPDATE crm_outbox SET status = 'pending', lease_until = NULL, lease_token = NULL WHERE event_id = $1 AND status = 'dead_lettered' RETURNING step",
        [eventId],
      );
      if (reset.rows.length === 0) throw new Error(`event ${eventId} has no dead-lettered step`);
      await c.query("UPDATE crm_dead_letters SET replayed = true WHERE event_id = $1 AND NOT replayed", [eventId]);
    });
    return drainEvent(eventId);
  }

  /** Dead-letter a step, only if this sender still holds it. Returns false if it doesn't. */
  async function deadLetter(eventId: string, step: Step, token: string, attempts: number, error: string) {
    return inTransaction(async (c) => {
      const marked = await c.query(
        `UPDATE crm_outbox SET status = 'dead_lettered', lease_until = NULL, lease_token = NULL
         WHERE event_id = $1 AND step = $2 AND status = 'sending' AND lease_token = $3
         RETURNING step`,
        [eventId, step, token],
      );
      if (marked.rows.length === 0) return false;
      await c.query(
        "INSERT INTO crm_dead_letters (event_id, step, attempts, error, at) VALUES ($1, $2, $3, $4, $5)",
        [eventId, step, attempts, error, deps.now().toISOString()],
      );
      return true;
    });
  }

  async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await deps.pool.connect();
    // Set only if ROLLBACK itself fails: the connection is in an unknown state, so it is
    // destroyed on release instead of going back to the pool.
    let broken: Error | undefined;
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      throw err;
    } finally {
      c.release(broken);
    }
  }

  async function query(sql: string, params?: unknown[]) {
    const client = await deps.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  return { handleWebhook, drainEvent, drainPending, deadLetters, replayDeadLetter };
}
