import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SIGNATURE_HEADER, WEBHOOK_PATH, createWebhookServer } from "../src/server.ts";
import { paymentEvent, setup, signed } from "./helpers.ts";

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
