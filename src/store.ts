// What the service remembers about each event: whether it was claimed, which side effects
// already happened, and anything that was dead-lettered. In production this is a database
// table with a unique key on the event id; here it is an in-memory implementation of the
// same interface.

export type Step = "crm_upsert" | "chat_alert";

export type EventStatus = "processing" | "done" | "dead_lettered" | "ignored";

export type EventRecord = {
  eventId: string;
  type: string;
  payload: unknown;
  status: EventStatus;
  completedSteps: Step[];
  receivedAt: string;
};

export type DeadLetter = {
  eventId: string;
  step: Step;
  attempts: number;
  error: string;
  at: string;
  replayed: boolean;
};

export interface EventStore {
  /** Atomically record the event if its id is new. Returns false if it was already seen. */
  claim(eventId: string, type: string, payload: unknown, at: string): boolean;
  get(eventId: string): EventRecord | undefined;
  markStep(eventId: string, step: Step): void;
  setStatus(eventId: string, status: EventStatus): void;
  addDeadLetter(dl: Omit<DeadLetter, "replayed">): void;
  deadLetters(): DeadLetter[];
  markReplayed(eventId: string): void;
}

export class MemoryStore implements EventStore {
  private events = new Map<string, EventRecord>();
  private dlq: DeadLetter[] = [];

  // Check and insert happen in one synchronous block, so two concurrent deliveries of the
  // same event cannot both claim it (the database version is INSERT ... ON CONFLICT DO NOTHING).
  claim(eventId: string, type: string, payload: unknown, at: string): boolean {
    if (this.events.has(eventId)) return false;
    this.events.set(eventId, { eventId, type, payload, status: "processing", completedSteps: [], receivedAt: at });
    return true;
  }

  get(eventId: string) {
    const r = this.events.get(eventId);
    return r && { ...r, completedSteps: [...r.completedSteps] };
  }

  markStep(eventId: string, step: Step) {
    const r = this.mustGet(eventId);
    if (!r.completedSteps.includes(step)) r.completedSteps.push(step);
  }

  setStatus(eventId: string, status: EventStatus) {
    this.mustGet(eventId).status = status;
  }

  addDeadLetter(dl: Omit<DeadLetter, "replayed">) {
    this.dlq.push({ ...dl, replayed: false });
  }

  deadLetters() {
    return this.dlq.map((d) => ({ ...d }));
  }

  markReplayed(eventId: string) {
    for (const d of this.dlq) if (d.eventId === eventId) d.replayed = true;
  }

  private mustGet(eventId: string) {
    const r = this.events.get(eventId);
    if (!r) throw new Error(`unknown event ${eventId}`);
    return r;
  }
}
