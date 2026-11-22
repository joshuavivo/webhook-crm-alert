// The webhook pipeline: verify -> de-duplicate -> CRM upsert -> chat alert.
// Each side effect is recorded as a completed step, so a retry or a replay resumes where
// the last attempt stopped instead of starting over.
import type { ChatClient, CrmClient } from "./clients.ts";
import { PermanentError } from "./clients.ts";
import { RetriesExhausted, errorMessage, withRetry, type RetryOptions } from "./retry.ts";
import { verifySignature } from "./signature.ts";
import type { EventStore, Step } from "./store.ts";

export type PaymentEvent = {
  id: string;
  type: string;
  created: number;
  data: { customer_email: string; customer_name?: string; amount_cents: number; currency: string };
};

export type Deps = {
  secret: string;
  crm: CrmClient;
  chat: ChatClient;
  store: EventStore;
  retry: Omit<RetryOptions, "isRetryable">;
  alertChannel: string;
  now: () => Date;
};

export type HandlerResult = { status: number; body: Record<string, unknown> };

const HANDLED_TYPE = "payment.succeeded";
const STEPS: Step[] = ["crm_upsert", "chat_alert"];

export function createHandler(deps: Deps) {
  const retryOpts: RetryOptions = { ...deps.retry, isRetryable: (e) => !(e instanceof PermanentError) };

  // rawBody is the bytes as received. Pass a Buffer from an HTTP server: decoding it to a
  // string first would turn invalid UTF-8 into U+FFFD and break a valid signature.
  async function handleWebhook(rawBody: string | Buffer, signatureHeader: string | undefined): Promise<HandlerResult> {
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    const sig = verifySignature(rawBody, signatureHeader, deps.secret, nowSec);
    if (!sig.ok) return { status: 401, body: { error: sig.reason } };

    let event: PaymentEvent;
    try {
      event = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "body is not JSON" } };
    }
    const problem = validate(event);
    if (problem) return { status: 400, body: { error: problem } };

    if (!deps.store.claim(event.id, event.type, event, deps.now().toISOString())) {
      // Already seen. The provider is retrying; acknowledge and do nothing.
      return { status: 200, body: { received: true, duplicate: true } };
    }
    if (event.type !== HANDLED_TYPE) {
      deps.store.setStatus(event.id, "ignored");
      return { status: 200, body: { received: true, ignored: event.type } };
    }

    const status = await runSteps(event);
    // 202 on dead-letter: the event is ours now. Asking the provider to retry would only
    // create a second copy of work we already recorded.
    return { status: status === "done" ? 200 : 202, body: { received: true, status } };
  }

  /** Re-run a dead-lettered event. Steps that already succeeded are skipped. */
  async function replayDeadLetter(eventId: string): Promise<"done" | "dead_lettered"> {
    const rec = deps.store.get(eventId);
    if (!rec) throw new Error(`unknown event ${eventId}`);
    if (rec.status !== "dead_lettered") throw new Error(`event ${eventId} is ${rec.status}, not dead_lettered`);
    deps.store.markReplayed(eventId);
    deps.store.setStatus(eventId, "processing");
    return runSteps(rec.payload as PaymentEvent);
  }

  async function runSteps(event: PaymentEvent): Promise<"done" | "dead_lettered"> {
    for (const step of STEPS) {
      if (deps.store.get(event.id)!.completedSteps.includes(step)) continue;
      try {
        await withRetry(() => perform(step, event), retryOpts);
        deps.store.markStep(event.id, step);
      } catch (err) {
        const attempts = err instanceof RetriesExhausted ? err.attempts : 1;
        const cause = err instanceof RetriesExhausted ? err.lastError : err;
        deps.store.addDeadLetter({ eventId: event.id, step, attempts, error: errorMessage(cause), at: deps.now().toISOString() });
        deps.store.setStatus(event.id, "dead_lettered");
        return "dead_lettered";
      }
    }
    deps.store.setStatus(event.id, "done");
    return "done";
  }

  async function perform(step: Step, event: PaymentEvent): Promise<void> {
    const d = event.data;
    if (step === "crm_upsert") {
      await deps.crm.upsertContact({
        email: d.customer_email,
        name: d.customer_name,
        lastPaymentCents: d.amount_cents,
        lastPaymentAt: new Date(event.created * 1000).toISOString(),
      });
    } else {
      const email = chatSafe(d.customer_email);
      // Parentheses, not <...>: customer text inside raw angle brackets can form a chat token
      // (an email of "!channel|a@b.co" became Slack's <!channel|...> mention).
      const who = d.customer_name ? `${chatSafe(d.customer_name)} (${email})` : email;
      await deps.chat.postMessage(deps.alertChannel, `Payment received: ${formatMoney(d.amount_cents, d.currency)} from ${who} (event ${chatSafe(event.id)})`);
    }
  }

  return { handleWebhook, replayDeadLetter };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // shape only; the provider already verified it

// Text the customer typed goes into a team chat. Keep it to one line and stop it from becoming
// a mention or a link: control characters and every line break (including U+2028/2029 and the
// C1 range) become spaces, &<> are escaped (Slack-style mention/link syntax), and every
// @everyone/@here/@channel gets a zero-width space, in the email too: x@everyone.com is a valid
// address and would still read as a mention. The cost is a hidden character in such an address. Ordinary formatting (*bold*) passes.
export function chatSafe(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/@(everyone|here|channel)/gi, "@\u200b$1"); // every field, the email too
}

const MAX_CREATED = 8.64e12; // seconds; new Date(ms) is valid up to 8.64e15 ms

function validate(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return "event must be an object";
  const ev = e as Partial<PaymentEvent>;
  if (typeof ev.id !== "string" || !ev.id) return "event.id is required";
  if (typeof ev.type !== "string" || !ev.type) return "event.type is required";
  if (ev.type !== HANDLED_TYPE) return null; // other types are acknowledged and ignored
  // Checked here, before the id is claimed: a value that can never succeed must get a 400, not be
  // retried and dead-lettered. MAX_CREATED is the largest Unix time a JS Date can represent.
  if (!Number.isSafeInteger(ev.created) || (ev.created as number) <= 0 || (ev.created as number) > MAX_CREATED) {
    return "event.created must be a Unix timestamp in seconds";
  }
  const d = ev.data;
  if (!d || typeof d.customer_email !== "string" || !EMAIL.test(d.customer_email)) return "data.customer_email must be an email address";
  if (d.customer_name !== undefined && (typeof d.customer_name !== "string" || d.customer_name.length > 200)) {
    return "data.customer_name must be text of at most 200 characters";
  }
  if (!Number.isSafeInteger(d.amount_cents) || d.amount_cents <= 0) return "data.amount_cents must be a positive whole number of minor units";
  if (typeof d.currency !== "string" || !/^[A-Za-z]{3}$/.test(d.currency)) return "data.currency must be a 3-letter code";
  return null;
}

// Currencies with no minor unit: the amount is already whole units (Stripe's zero-decimal list;
// UGX is left out because Stripe sends it with two decimals).
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);

// Currencies with three decimal places (1 dinar = 1000 fils).
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function formatMoney(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  if (ZERO_DECIMAL.has(code)) return `${sign}${abs} ${code}`;
  const places = THREE_DECIMAL.has(code) ? 3 : 2;
  const unit = 10 ** places;
  return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(places, "0")} ${code}`;
}
