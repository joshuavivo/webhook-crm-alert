// Webhook signature check, shaped like the common "timestamp + HMAC" scheme.
// Header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
// The timestamp is signed too, so an old delivery cannot be replayed with a fresh header.
// The body is HMACed as bytes. A Buffer is used as-is; a string is encoded as UTF-8.
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

function mac(rawBody: string | Uint8Array, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

export function sign(rawBody: string | Uint8Array, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${mac(rawBody, secret, timestamp)}`;
}

export function verifySignature(
  rawBody: string | Uint8Array,
  header: string | undefined,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): SignatureResult {
  if (!header) return { ok: false, reason: "missing signature header" };

  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t") timestamp = Number(v);
    if (k === "v1" && v) candidates.push(v);
  }
  if (timestamp === undefined || !Number.isInteger(timestamp)) return { ok: false, reason: "missing or bad timestamp" };
  if (candidates.length === 0) return { ok: false, reason: "missing v1 signature" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };

  const expected = Buffer.from(mac(rawBody, secret, timestamp), "utf8");
  // Several v1 values are allowed so a secret can be rotated without dropping events.
  for (const c of candidates) {
    const given = Buffer.from(c, "utf8");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
