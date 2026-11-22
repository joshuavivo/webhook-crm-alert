import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SIGNATURE_HEADER, WEBHOOK_PATH, createWebhookServer } from "../src/server.ts";
import { NOW_SEC, SECRET, paymentEvent, setup, signed } from "./helpers.ts";

test("over HTTP: signed POST is accepted, unsigned is 401, wrong path is 404", async (t) => {
  const { handler, crm } = setup();
  const server = createWebhookServer(handler).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = paymentEvent();

  const ok = await fetch(base + WEBHOOK_PATH, { method: "POST", body, headers: { [SIGNATURE_HEADER]: signed(body) } });
  assert.equal(ok.status, 200);
  assert.equal(crm.calls, 1);

  const unsigned = await fetch(base + WEBHOOK_PATH, { method: "POST", body });
  assert.equal(unsigned.status, 401);

  const wrong = await fetch(base + "/other", { method: "POST", body });
  assert.equal(wrong.status, 404);
});

test("over HTTP: the signature is checked over the raw bytes, even when they are not valid UTF-8", async (t) => {
  const { handler, crm } = setup();
  const server = createWebhookServer(handler).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A lone 0xff byte inside a JSON string. Decoding it to text turns it into U+FFFD, which
  // re-encodes as three different bytes, so an HMAC over decoded text would not match.
  const [head, tail] = paymentEvent("evt_ff", { data: { customer_email: "ada@example.com", customer_name: "Ada~", amount_cents: 4200, currency: "usd" } }).split("~");
  const body = Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]);
  assert.notDeepEqual(Buffer.from(body.toString("utf8")), body, "fixture must not survive a UTF-8 round trip");

  // Signed the way a provider signs: HMAC over the bytes, computed here rather than with
  // the code under test, so a lossy decode in sign() cannot hide a lossy decode in verify.
  const mac = createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${NOW_SEC}.`), body])).digest("hex");
  const res = await fetch(base + WEBHOOK_PATH, { method: "POST", body, headers: { [SIGNATURE_HEADER]: `t=${NOW_SEC},v1=${mac}` } });
  assert.equal(res.status, 200);
  assert.equal(crm.calls, 1);
});

test("over HTTP: a body over 256 KiB is refused with 413 and nothing is written", async (t) => {
  const { handler, crm, store } = setup();
  const server = createWebhookServer(handler).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const body = paymentEvent("evt_big", { padding: "x".repeat(300 * 1024) });
  const res = await fetch(base + WEBHOOK_PATH, { method: "POST", body, headers: { [SIGNATURE_HEADER]: signed(body) } });
  assert.equal(res.status, 413);
  assert.equal(crm.calls, 0);
  assert.equal(store.get("evt_big"), undefined);
});
