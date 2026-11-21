import assert from "node:assert/strict";
import { test } from "node:test";
import { verifySignature } from "../src/signature.ts";
import { NOW_SEC, SECRET, paymentEvent, setup, signed } from "./helpers.ts";

test("a correctly signed body verifies", () => {
  const body = paymentEvent();
  assert.deepEqual(verifySignature(body, signed(body), SECRET, NOW_SEC), { ok: true });
});

test("bad signature is rejected with 401 and nothing is written", async () => {
  const { handler, crm, chat, store } = setup();
  const body = paymentEvent();
  const res = await handler.handleWebhook(body, signed(body, NOW_SEC, "wrong_secret"));
  assert.equal(res.status, 401);
  assert.equal(crm.calls, 0);
  assert.equal(chat.calls, 0);
  assert.equal(store.get("evt_001"), undefined, "a rejected delivery must not claim the event id");
});

test("a body changed after signing is rejected", async () => {
  const { handler, crm } = setup();
  const header = signed(paymentEvent());
  const tampered = paymentEvent("evt_001", { data: { customer_email: "ada@example.com", amount_cents: 1, currency: "usd" } });
  assert.equal((await handler.handleWebhook(tampered, header)).status, 401);
  assert.equal(crm.calls, 0);
});

test("missing header, missing timestamp and missing v1 are each rejected, and nothing is written", async () => {
  const { handler, crm, chat, store } = setup();
  const body = paymentEvent();
  const mac = signed(body).split(",")[1];
  for (const header of [undefined, mac, `t=${NOW_SEC}`]) {
    assert.equal(verifySignature(body, header, SECRET, NOW_SEC).ok, false);
    assert.equal((await handler.handleWebhook(body, header)).status, 401);
  }
  assert.equal(crm.calls, 0);
  assert.equal(chat.calls, 0);
  assert.equal(store.get("evt_001"), undefined);
});

test("a validly signed but stale delivery is rejected (replay window), and nothing is written", async () => {
  const { handler, crm, chat, store } = setup();
  const body = paymentEvent();
  const header = signed(body, NOW_SEC - 301);
  assert.deepEqual(verifySignature(body, header, SECRET, NOW_SEC), { ok: false, reason: "timestamp outside tolerance" });
  assert.equal((await handler.handleWebhook(body, header)).status, 401);
  assert.equal(crm.calls, 0);
  assert.equal(chat.calls, 0);
  assert.equal(store.get("evt_001"), undefined);
});

test("rotation: any one valid v1 among several passes", () => {
  const body = paymentEvent();
  const good = signed(body).split(",")[1];
  const header = `t=${NOW_SEC},v1=${"0".repeat(64)},${good}`;
  assert.equal(verifySignature(body, header, SECRET, NOW_SEC).ok, true);
});
