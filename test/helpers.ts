import { FakeChat, FakeCrm } from "../src/clients.ts";
import { createHandler } from "../src/handler.ts";
import { sign } from "../src/signature.ts";
import { MemoryStore } from "../src/store.ts";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const NOW = new Date("2026-01-15T12:00:00Z");
export const NOW_SEC = Math.floor(NOW.getTime() / 1000);

export function setup(attempts = 3) {
  const crm = new FakeCrm();
  const chat = new FakeChat();
  const store = new MemoryStore();
  const sleeps: number[] = [];
  const handler = createHandler({
    secret: SECRET,
    crm,
    chat,
    store,
    retry: { attempts, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms) => void sleeps.push(ms) },
    alertChannel: "#payments",
    now: () => NOW,
  });
  return { crm, chat, store, sleeps, handler };
}

export function paymentEvent(id = "evt_001", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    type: "payment.succeeded",
    created: NOW_SEC - 5,
    data: { customer_email: "ada@example.com", customer_name: "Ada Example", amount_cents: 4200, currency: "usd" },
    ...overrides,
  });
}

export const signed = (body: string, at = NOW_SEC, secret = SECRET) => sign(body, secret, at);
