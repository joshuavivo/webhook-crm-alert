// The Postgres path, against a real Postgres. Runs when DATABASE_URL is set (CI sets it,
// with REQUIRE_POSTGRES=1 so a missing database fails the run instead of skipping it).
// A plain `npm test` with no database skips this file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Pool, PoolClient } from "exactly-once-webhooks";
import { FakeChat, FakeCrm, PermanentError, type ContactFields, type CrmClient } from "../src/clients.ts";
import { NOW, paymentEvent, signed } from "./helpers.ts";

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_POSTGRES === "1") throw new Error("REQUIRE_POSTGRES=1 but DATABASE_URL is not set");

// Each run gets its own schema, created here and dropped at the end, so a leftover row
// from an aborted run (or a run in parallel) can't change the counts. Ids are salted too.
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const schema = `crm_test_${run}`;
const id = (name: string) => `evt_${run}_${name}`;

type EndablePool = Pool & { end(): Promise<void> };
let shared: { pool: EndablePool; newPool: () => EndablePool; mod: typeof import("../src/pg-pipeline.ts") } | undefined;
const extraPools: EndablePool[] = [];

async function env() {
  if (shared) return shared;
  // Loaded only when a database is configured, so `npm test` without one needs no install.
  const pgSpecifier = "pg";
  const pg = (await import(pgSpecifier)) as { default: { Pool: new (c: object) => EndablePool } };
  const config = (max: number) => ({ connectionString: url, max, options: `-c search_path=${schema}` });
  const newPool = () => {
    const p = new pg.default.Pool(config(10));
    extraPools.push(p);
    return p;
  };
  const pool = new pg.default.Pool(config(20));
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    const flagshipSchema = new URL("../node_modules/exactly-once-webhooks/schema.sql", import.meta.url);
    await client.query(await readFile(flagshipSchema, "utf8"));
    await client.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  } finally {
    client.release();
  }
  shared = { pool, newPool, mod: await import("../src/pg-pipeline.ts") };
  return shared;
}

type SetupOpts = {
  pool?: Pool;
  drain?: "inline" | "deferred";
  attempts?: number;
  leaseMs?: number;
  crm?: CrmClient;
  onDrainError?: (err: unknown, eventId: string) => void;
};

async function setup(opts: SetupOpts = {}) {
  const { pool, mod } = await env();
  const crm = new FakeCrm();
  const chat = new FakeChat();
  const p = mod.createPostgresPipeline({
    secret: "whsec_test_only_not_a_real_secret",
    crm: opts.crm ?? crm,
    chat,
    pool: opts.pool ?? pool,
    retry: { attempts: opts.attempts ?? 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
    alertChannel: "#payments",
    now: () => NOW,
    drain: opts.drain,
    leaseMs: opts.leaseMs,
    onDrainError: opts.onDrainError ?? (() => {}),
  });
  const deliver = (body: string) => p.handleWebhook(body, signed(body));
  return { p, crm, chat, deliver, pool };
}

async function rows(sql: string, params: unknown[]) {
  const { pool } = await env();
  const c = await pool.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    c.release();
  }
}
const count = async (table: string, eventId: string) =>
  Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE event_id = $1`, [eventId]))[0].n);

// A pool whose clients fail at COMMIT once, after the outbox rows were written: the
// process "dies" between claiming the event and committing it. With afterCommit, the
// COMMIT goes through and only the reply is lost.
function crashAtCommit(pool: Pool, afterCommit = false): Pool {
  let armed = true;
  return {
    async connect(): Promise<PoolClient> {
      const c = await pool.connect();
      let wroteOutbox = false;
      return {
        release: (e?: Error | boolean) => c.release(e),
        async query(sql: string, params?: unknown[]) {
          if (/INSERT INTO crm_outbox/.test(sql)) wroteOutbox = true;
          if (armed && wroteOutbox && sql === "COMMIT") {
            armed = false;
            if (afterCommit) await c.query(sql, params);
            throw new Error(afterCommit ? "connection lost after COMMIT" : "connection lost before COMMIT");
          }
          return c.query(sql, params);
        },
      };
    },
  };
}

const opts = { skip: url ? false : "DATABASE_URL not set" };

// A pool that fails one kind of query, to stand in for the database going away.
function failing(pool: Pool, pattern: RegExp): Pool {
  return {
    async connect(): Promise<PoolClient> {
      const c = await pool.connect();
      return {
        release: (e?: Error | boolean) => c.release(e),
        async query(sql: string, params?: unknown[]) {
          if (pattern.test(sql)) throw new Error("database unavailable");
          return c.query(sql, params);
        },
      };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  await Promise.all(extraPools.map((p) => p.end()));
  if (!shared) return;
  const c = await shared.pool.connect();
  try {
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    c.release();
  }
  await shared.pool.end();
});

test("pg: 12 concurrent deliveries over 3 pipelines with their own pools: one event row, one outbox row per step, each call once", opts, async () => {
  const { newPool } = await env();
  const pipelines = await Promise.all([setup({ pool: newPool() }), setup({ pool: newPool() }), setup({ pool: newPool() })]);
  const body = paymentEvent(id("concurrent"));
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => pipelines[i % 3].deliver(body)));
  assert.equal(results.filter((r) => r.body.duplicate !== true).length, 1);
  assert.equal(await count("crm_events", id("concurrent")), 1);
  assert.equal(await count("crm_outbox", id("concurrent")), 2);
  assert.equal(pipelines.reduce((n, s) => n + s.crm.calls, 0), 1);
  assert.equal(pipelines.reduce((n, s) => n + s.chat.calls, 0), 1);
});

test("pg: a crash before COMMIT leaves nothing behind, and the provider's retry processes the event", opts, async () => {
  const { pool } = await env();
  const crashing = await setup({ pool: crashAtCommit(pool) });
  const body = paymentEvent(id("crash"));
  await assert.rejects(crashing.deliver(body), /connection lost before COMMIT/);
  assert.equal(await count("crm_events", id("crash")), 0);
  assert.equal((await rows("SELECT 1 FROM idempotency_keys WHERE key = $1", [id("crash")])).length, 0);
  assert.equal(crashing.crm.calls, 0);

  const retry = await setup();
  const res = await retry.deliver(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, undefined);
  assert.equal(retry.crm.calls, 1);
  assert.equal(retry.chat.calls, 1);
});

test("pg: after a restart (a new pipeline on the same database) a duplicate is still refused", opts, async () => {
  const body = paymentEvent(id("restart"));
  const first = await setup();
  assert.equal((await first.deliver(body)).status, 200);
  const second = await setup();
  const again = await second.deliver(body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(second.crm.calls + second.chat.calls, 0);
});

test("pg: committed but never sent (deferred, or the sender died): drainPending sends it once", opts, async () => {
  const committer = await setup({ drain: "deferred" });
  const res = await committer.deliver(paymentEvent(id("deferred")));
  assert.equal(res.status, 202);
  assert.equal(committer.crm.calls, 0);

  const worker = await setup();
  const drained = await worker.p.drainPending();
  assert.equal(drained[id("deferred")], "done");
  assert.equal(worker.crm.calls, 1);
  assert.equal(worker.chat.calls, 1);
  assert.equal((await worker.p.drainPending())[id("deferred")], undefined);
});

test("pg: a sender holding a step under a live lease blocks the next step; an expired lease is taken over", opts, async () => {
  const committer = await setup({ drain: "deferred" });
  await committer.deliver(paymentEvent(id("lease")));
  // A sender took the CRM step and is still inside its lease.
  await rows("UPDATE crm_outbox SET status = 'sending', lease_until = now() + interval '1 hour' WHERE event_id = $1 AND step = 'crm_upsert'", [id("lease")]);
  const other = await setup();
  assert.equal(await other.p.drainEvent(id("lease")), "in_progress");
  assert.equal(other.crm.calls + other.chat.calls, 0, "the chat alert must not overtake the CRM step");

  // That sender died: its lease ran out. The step is taken over and sent.
  await rows("UPDATE crm_outbox SET lease_until = now() - interval '1 second' WHERE event_id = $1 AND step = 'crm_upsert'", [id("lease")]);
  assert.equal(await other.p.drainEvent(id("lease")), "done");
  assert.equal(other.crm.calls, 1);
  assert.equal(other.chat.calls, 1);
});

test("pg: retries exhausted → dead letter; a replay sends only the step that failed", opts, async () => {
  const s = await setup({ attempts: 3 });
  s.chat.failures = [new Error("503"), new Error("503"), new Error("503 still")];
  const res = await s.deliver(paymentEvent(id("dlq")));
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "dead_lettered");
  const dl = (await s.p.deadLetters()).filter((d) => d.eventId === id("dlq"));
  assert.deepEqual(dl.map((d) => [d.step, d.attempts, d.error, d.replayed]), [["chat_alert", 3, "503 still", false]]);

  assert.equal(await s.p.replayDeadLetter(id("dlq")), "done");
  assert.equal(s.crm.calls, 1, "the CRM step already went out and is not repeated");
  assert.equal(s.chat.messages.length, 1);
  assert.equal((await s.p.deadLetters()).find((d) => d.eventId === id("dlq"))?.replayed, true);
  await assert.rejects(s.p.replayDeadLetter(id("dlq")), /no dead-lettered step/);
});

test("pg: a CRM failure stops the pipeline before the alert", opts, async () => {
  const s = await setup();
  s.crm.failures = [new PermanentError("400 bad contact")];
  const res = await s.deliver(paymentEvent(id("crmfail")));
  assert.equal(res.body.status, "dead_lettered");
  assert.equal(s.chat.calls, 0);
});

test("pg: other event types are recorded and acknowledged, with nothing to send", opts, async () => {
  const s = await setup();
  const body = paymentEvent(id("refund"), { type: "payment.refunded" });
  const res = await s.deliver(body);
  assert.equal(res.body.ignored, "payment.refunded");
  assert.equal(await count("crm_events", id("refund")), 1);
  assert.equal(await count("crm_outbox", id("refund")), 0);
  assert.equal((await s.deliver(body)).body.duplicate, true);
});

test("pg: a bad signature claims nothing", opts, async () => {
  const s = await setup();
  const body = paymentEvent(id("badsig"));
  const res = await s.p.handleWebhook(body, "t=1,v1=00");
  assert.equal(res.status, 401);
  assert.equal(await count("crm_events", id("badsig")), 0);
});

test("pg: COMMIT went through but its reply was lost: the retry is a duplicate, and drainPending sends the calls", opts, async () => {
  const { pool } = await env();
  const lost = await setup({ pool: crashAtCommit(pool, true) });
  const body = paymentEvent(id("acklost"));
  await assert.rejects(lost.deliver(body), /connection lost after COMMIT/);
  const retry = await setup();
  assert.equal((await retry.deliver(body)).body.duplicate, true);
  assert.equal(retry.crm.calls, 0);
  assert.equal((await retry.p.drainPending())[id("acklost")], "done");
  assert.equal(retry.crm.calls, 1);
  assert.equal(retry.chat.calls, 1);
});

test("pg: two senders draining one event at once make each call once", opts, async () => {
  const committer = await setup({ drain: "deferred" });
  await committer.deliver(paymentEvent(id("race")));
  const a = await setup();
  const b = await setup();
  const outcomes = await Promise.all([a.p.drainEvent(id("race")), b.p.drainEvent(id("race"))]);
  assert.ok(outcomes.includes("done"), `one sender finishes: ${outcomes}`);
  assert.equal(a.crm.calls + b.crm.calls, 1);
  assert.equal(a.chat.calls + b.chat.calls, 1);
});

test("pg: a sender that stalls past its lease can't overwrite the sender that took over", opts, async () => {
  const committer = await setup({ drain: "deferred" });
  await committer.deliver(paymentEvent(id("stale")));

  // Sender A's CRM call outlives its 50 ms lease, then fails permanently. A's call is held
  // open by a signal; the test polls the database until A's lease has expired, lets B take
  // over and finish, and only then lets A's call return.
  let calls = 0;
  let inCall!: () => void;
  const aInCall = new Promise<void>((r) => (inCall = r));
  let release!: () => void;
  const aMayFinish = new Promise<void>((r) => (release = r));
  const slowCrm: CrmClient = {
    async upsertContact(_f: ContactFields) {
      calls++;
      inCall();
      await aMayFinish;
      throw new PermanentError("A gave up");
    },
  };
  const a = await setup({ crm: slowCrm, leaseMs: 50 });
  const aDone = a.p.drainEvent(id("stale"));
  await aInCall;
  for (let i = 0; ; i++) {
    const [r] = await rows("SELECT lease_until < now() AS expired FROM crm_outbox WHERE event_id = $1 AND step = 'crm_upsert'", [id("stale")]);
    if (r.expired) break;
    assert.ok(i < 200, "A's lease never expired");
    await sleep(10);
  }

  const b = await setup();
  assert.equal(await b.p.drainEvent(id("stale")), "done");
  assert.equal(b.crm.calls, 1);
  assert.equal(b.chat.calls, 1);
  release();

  // A finishes late. Its dead letter must not land: B already sent both steps.
  assert.equal(await aDone, "in_progress");
  assert.equal(calls, 1);
  const states = await rows("SELECT step, status FROM crm_outbox WHERE event_id = $1 ORDER BY step", [id("stale")]);
  assert.deepEqual(states.map((r) => `${r.step}:${r.status}`), ["chat_alert:sent", "crm_upsert:sent"]);
  assert.equal((await b.p.deadLetters()).filter((d) => d.eventId === id("stale")).length, 0);
});

test("pg: leaseMs must be a positive integer", opts, async () => {
  const { mod, pool } = await env();
  for (const leaseMs of [0, -5, Number.NaN, 1.5]) {
    assert.throws(
      () =>
        mod.createPostgresPipeline({
          secret: "s", crm: new FakeCrm(), chat: new FakeChat(), pool, alertChannel: "#x", now: () => NOW, leaseMs,
          retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
        }),
      /leaseMs must be a positive integer/,
    );
  }
});

test("pg: a failed send after the commit is reported, answered 202, and sent later", opts, async () => {
  const { pool } = await env();
  const reported: string[] = [];
  const s = await setup({ pool: failing(pool, /^SELECT payload/), onDrainError: (_e, eventId) => void reported.push(eventId) });
  const res = await s.deliver(paymentEvent(id("dbdown")));
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "queued");
  assert.deepEqual(reported, [id("dbdown")]);

  const worker = await setup();
  assert.equal((await worker.p.drainPending())[id("dbdown")], "done");
  assert.equal(worker.crm.calls, 1);
});

test("pg: an event with a dead-lettered step waits for a replay instead of being drained again", opts, async () => {
  const s = await setup();
  s.crm.failures = [new PermanentError("400")];
  assert.equal((await s.deliver(paymentEvent(id("parked")))).body.status, "dead_lettered");
  assert.equal((await s.p.drainPending())[id("parked")], undefined);
  assert.equal(await s.p.replayDeadLetter(id("parked")), "done");
  assert.equal(s.crm.calls, 2);
  assert.equal(s.chat.calls, 1);
});

test("pg: draining an ignored event has nothing to send", opts, async () => {
  const s = await setup();
  await s.deliver(paymentEvent(id("ignored"), { type: "payment.refunded" }));
  assert.equal(await s.p.drainEvent(id("ignored")), "done");
});

test("pg: a sender whose late call succeeds after a takeover doesn't mark it or send the alert", opts, async () => {
  const committer = await setup({ drain: "deferred" });
  await committer.deliver(paymentEvent(id("stale_ok")));

  let inCall!: () => void;
  const aInCall = new Promise<void>((r) => (inCall = r));
  let release!: () => void;
  const aMayFinish = new Promise<void>((r) => (release = r));
  const slowCrm: CrmClient = {
    async upsertContact(_f: ContactFields) {
      inCall();
      await aMayFinish;
      return { contactId: "late" }; // A's call went through, after its lease had expired
    },
  };
  const a = await setup({ crm: slowCrm, leaseMs: 50 });
  const aDone = a.p.drainEvent(id("stale_ok"));
  await aInCall;
  for (let i = 0; ; i++) {
    const [r] = await rows("SELECT lease_until < now() AS expired FROM crm_outbox WHERE event_id = $1 AND step = 'crm_upsert'", [id("stale_ok")]);
    if (r.expired) break;
    assert.ok(i < 200, "A's lease never expired");
    await sleep(10);
  }
  const b = await setup();
  assert.equal(await b.p.drainEvent(id("stale_ok")), "done");
  release();

  // A's mark finds a token that is no longer its own, so A stops instead of sending the alert.
  assert.equal(await aDone, "in_progress");
  assert.equal(a.chat.calls + b.chat.calls, 1);
});
