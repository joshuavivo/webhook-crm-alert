// HTTP entry point. The signature is computed over the exact bytes received, so the body is
// read raw and never re-serialized before verification.
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { FakeChat, FakeCrm } from "./clients.ts";
import { createHandler } from "./handler.ts";
import { realSleep } from "./retry.ts";
import { MemoryStore } from "./store.ts";

export const WEBHOOK_PATH = "/webhooks/payments";
export const SIGNATURE_HEADER = "payment-signature";
const MAX_BODY_BYTES = 256 * 1024;

export function createWebhookServer(handler: ReturnType<typeof createHandler>): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== WEBHOOK_PATH) return reply(404, { error: "not found" });

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on("end", async () => {
      if (tooLarge) return reply(413, { error: "body too large" });
      try {
        const header = req.headers[SIGNATURE_HEADER];
        const result = await handler.handleWebhook(Buffer.concat(chunks), Array.isArray(header) ? header[0] : header);
        reply(result.status, result.body);
      } catch {
        reply(500, { error: "internal error" });
      }
    });
  });
}

// `npm start`: run locally against the in-memory fakes.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("Set WEBHOOK_SECRET first.");
    process.exit(1);
  }
  const handler = createHandler({
    secret,
    crm: new FakeCrm(),
    chat: new FakeChat(),
    store: new MemoryStore(),
    retry: { attempts: 4, baseDelayMs: 200, maxDelayMs: 2000, sleep: realSleep },
    alertChannel: "#payments",
    now: () => new Date(),
  });
  const port = Number(process.env.PORT ?? 3000);
  createWebhookServer(handler).listen(port, () => console.log(`listening on :${port}${WEBHOOK_PATH}`));
}
