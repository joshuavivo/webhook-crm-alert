import assert from "node:assert/strict";
import { test } from "node:test";
import { PermanentError } from "../src/clients.ts";
import { backoffDelays } from "../src/retry.ts";
import { paymentEvent, setup, signed } from "./helpers.ts";

const deliver = (h: ReturnType<typeof setup>["handler"], body: string) => h.handleWebhook(body, signed(body));

test("happy path: one CRM upsert and one alert", async () => {
  const { handler, crm, chat, store } = setup();
  const res = await deliver(handler, paymentEvent());
  assert.equal(res.status, 200);
  assert.equal(crm.contacts.get("ada@example.com")?.lastPaymentCents, 4200);
  assert.deepEqual(chat.messages, [
    { channel: "#payments", text: "Payment received: 42.00 USD from Ada Example <ada@example.com> (event evt_001)" },
  ]);
  assert.equal(store.get("evt_001")?.status, "done");
});

test("replayed event writes nothing", async () => {
  const { handler, crm, chat } = setup();
  const body = paymentEvent();
  await deliver(handler, body);
  const again = await deliver(handler, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(crm.calls, 1);
  assert.equal(chat.calls, 1);
});

test("two concurrent deliveries of one event: only one does the work", async () => {
  const { handler, crm, chat } = setup();
  const body = paymentEvent();
  const results = await Promise.all([deliver(handler, body), deliver(handler, body)]);
  assert.deepEqual(results.map((r) => r.body.duplicate === true).sort(), [false, true]);
  assert.equal(crm.calls, 1);
  assert.equal(chat.calls, 1);
});

test("a transient failure is retried with backoff and then succeeds", async () => {
  const { handler, crm, sleeps } = setup(3);
  crm.failures = [new Error("503"), new Error("timeout")];
  const res = await deliver(handler, paymentEvent());
  assert.equal(res.status, 200);
  assert.equal(crm.calls, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("a failing outbound call is retried, then dead-lettered", async () => {
  const { handler, chat, store, sleeps } = setup(3);
  chat.failures = [new Error("503"), new Error("503"), new Error("503 still")];
  const res = await deliver(handler, paymentEvent());
  assert.equal(res.status, 202);
  assert.equal(chat.calls, 3);
  assert.deepEqual(sleeps, [100, 200]);
  const [dl] = store.deadLetters();
  assert.equal(dl.eventId, "evt_001");
  assert.equal(dl.step, "chat_alert");
  assert.equal(dl.attempts, 3);
  assert.equal(dl.error, "503 still");
  assert.equal(store.get("evt_001")?.status, "dead_lettered");
});

test("a permanent error is not retried; it is dead-lettered on the first attempt", async () => {
  const { handler, crm, store, sleeps } = setup(3);
  crm.failures = [new PermanentError("400 invalid email")];
  await deliver(handler, paymentEvent());
  assert.equal(crm.calls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(store.deadLetters()[0].attempts, 1);
});

test("partial failure does not duplicate the CRM write (provider retry and manual replay)", async () => {
  const { handler, crm, chat, store } = setup(2);
  chat.failures = [new Error("503"), new Error("503")];
  const body = paymentEvent();

  await deliver(handler, body);
  assert.equal(crm.calls, 1, "CRM succeeded once");
  assert.deepEqual(store.get("evt_001")?.completedSteps, ["crm_upsert"]);

  // The provider retries the same event: acknowledged, nothing re-run.
  await deliver(handler, body);
  assert.equal(crm.calls, 1);

  // An operator replays the dead letter once chat is healthy: only the alert runs.
  const outcome = await handler.replayDeadLetter("evt_001");
  assert.equal(outcome, "done");
  assert.equal(crm.calls, 1, "CRM upsert must not run again");
  assert.equal(chat.messages.length, 1);
  assert.equal(store.deadLetters()[0].replayed, true);
  assert.equal(store.get("evt_001")?.status, "done");
});

test("a CRM failure stops the pipeline before the alert is posted", async () => {
  const { handler, crm, chat, store } = setup(2);
  crm.failures = [new Error("503"), new Error("503")];
  await deliver(handler, paymentEvent());
  assert.equal(chat.calls, 0);
  assert.equal(store.deadLetters()[0].step, "crm_upsert");
});

test("replay refuses an event that is not dead-lettered", async () => {
  const { handler } = setup();
  await deliver(handler, paymentEvent());
  await assert.rejects(handler.replayDeadLetter("evt_001"), /not dead_lettered/);
  await assert.rejects(handler.replayDeadLetter("evt_nope"), /unknown event/);
});

test("other event types are acknowledged and ignored", async () => {
  const { handler, crm, store } = setup();
  const res = await deliver(handler, JSON.stringify({ id: "evt_002", type: "payment.refunded" }));
  assert.equal(res.status, 200);
  assert.equal(crm.calls, 0);
  assert.equal(store.get("evt_002")?.status, "ignored");
});

test("malformed payloads get 400 and do not claim the id", async () => {
  const { handler, store } = setup();
  assert.equal((await deliver(handler, "not json")).status, 400);
  const noEmail = paymentEvent("evt_003", { data: { amount_cents: 4200, currency: "usd" } });
  assert.equal((await deliver(handler, noEmail)).status, 400);
  const floatAmount = paymentEvent("evt_004", { data: { customer_email: "a@example.com", amount_cents: 42.5, currency: "usd" } });
  assert.equal((await deliver(handler, floatAmount)).status, 400);
  assert.equal(store.get("evt_003"), undefined);
  assert.equal(store.get("evt_004"), undefined);
});

test("an impossible timestamp or amount is rejected at the door, not retried into the dead letter", async () => {
  // created: 1e15 passed the old typeof check, then new Date(...).toISOString() threw inside the
  // CRM step: retried, dead-lettered with a 202, and every replay would fail the same way.
  const { handler, store, crm, chat, sleeps } = setup();
  const data = { customer_email: "a@example.com", amount_cents: 4200, currency: "usd" };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["evt_010", { created: 1e15 }],
    ["evt_011", { created: -5 }],
    ["evt_012", { data: { ...data, amount_cents: 0 } }],
    ["evt_013", { data: { ...data, amount_cents: -4200 } }],
    ["evt_014", { data: { ...data, amount_cents: 2 ** 60 } }],
    ["evt_015", { data: { ...data, currency: "$$$" } }],
  ];
  for (const [id, overrides] of cases) {
    const res = await deliver(handler, paymentEvent(id, overrides));
    assert.equal(res.status, 400, `${id} should be rejected`);
    assert.equal(store.get(id), undefined, `${id} should not claim the id`);
  }
  assert.equal(crm.calls, 0);
  assert.equal(chat.calls, 0);
  assert.deepEqual(sleeps, []);
});

test("zero-decimal currencies are not divided by 100 in the alert", async () => {
  // 1000 JPY is a thousand yen, not 10.00: JPY and KRW have no minor unit.
  const { handler, chat } = setup();
  const body = paymentEvent("evt_020", { data: { customer_email: "a@example.com", amount_cents: 1000, currency: "jpy" } });
  assert.equal((await deliver(handler, body)).status, 200);
  assert.match(chat.messages[0].text, /Payment received: 1000 JPY from a@example\.com/);
});

test("three-decimal currencies are divided by 1000 in the alert", async () => {
  // 5120 KWD minor units is 5.120 dinar, not 51.20.
  const { handler, chat } = setup();
  const body = paymentEvent("evt_021", { data: { customer_email: "a@example.com", amount_cents: 5120, currency: "kwd" } });
  assert.equal((await deliver(handler, body)).status, 200);
  assert.match(chat.messages[0].text, /Payment received: 5\.120 KWD from a@example\.com/);
});

test("a customer name or email that can't be real is rejected at the door", async () => {
  const { handler, store, chat } = setup();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["evt_030", { customer_email: "a@example.com", customer_name: { a: 1 }, amount_cents: 4200, currency: "usd" }],
    ["evt_031", { customer_email: "@", amount_cents: 4200, currency: "usd" }],
    ["evt_032", { customer_email: "a b@example.com", amount_cents: 4200, currency: "usd" }],
  ];
  for (const [id, data] of cases) {
    assert.equal((await deliver(handler, paymentEvent(id, { data }))).status, 400, `${id} should be rejected`);
    assert.equal(store.get(id), undefined);
  }
  assert.equal(chat.calls, 0);
});

test("text the customer typed can't add mentions or lines to the alert", async () => {
  // Whoever types a name at checkout must not be able to ping the channel or forge a line.
  const { handler, chat } = setup();
  const name = "<!channel> @everyone\nPayment received: 99999.00 USD from ceo@example.com";
  const body = paymentEvent("evt_033", { data: { customer_email: "a@example.com", customer_name: name, amount_cents: 4200, currency: "usd" } });
  assert.equal((await deliver(handler, body)).status, 200);
  const text = chat.messages[0].text;
  assert.equal(text.split("\n").length, 1);
  assert.doesNotMatch(text, /<!channel>|@everyone/);
  assert.match(text, /^Payment received: 42\.00 USD from /);
});

test("backoff doubles and is capped at maxDelayMs", () => {
  assert.deepEqual(backoffDelays({ attempts: 6, baseDelayMs: 100, maxDelayMs: 500 }), [100, 200, 400, 500, 500]);
});
