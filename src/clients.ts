// The two outbound systems, as interfaces. Real adapters would wrap a CRM's contacts API
// and a chat tool's incoming-webhook API; this repo ships only in-memory fakes.

export type ContactFields = { email: string; name?: string; lastPaymentCents?: number; lastPaymentAt?: string };

export interface CrmClient {
  /** Create the contact, or update it if one with this email exists. Returns the CRM's contact id. */
  upsertContact(fields: ContactFields): Promise<{ contactId: string }>;
}

export interface ChatClient {
  postMessage(channel: string, text: string): Promise<void>;
}

/** Thrown by a client for a failure that retrying will not fix (bad request, auth). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** A queue of scripted failures: each call consumes one entry; an empty queue means success. */
type Script = Array<Error | null>;

export class FakeCrm implements CrmClient {
  readonly contacts = new Map<string, ContactFields & { contactId: string }>();
  calls = 0;
  failures: Script = [];

  async upsertContact(fields: ContactFields) {
    this.calls++;
    const fail = this.failures.shift();
    if (fail) throw fail;
    const existing = this.contacts.get(fields.email);
    const contactId = existing?.contactId ?? `contact_${this.contacts.size + 1}`;
    this.contacts.set(fields.email, { ...existing, ...fields, contactId });
    return { contactId };
  }
}

export class FakeChat implements ChatClient {
  readonly messages: Array<{ channel: string; text: string }> = [];
  calls = 0;
  failures: Script = [];

  async postMessage(channel: string, text: string) {
    this.calls++;
    const fail = this.failures.shift();
    if (fail) throw fail;
    this.messages.push({ channel, text });
  }
}
