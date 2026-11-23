-- Schema for the Postgres path (src/pg-pipeline.ts). Postgres 13 or newer
-- (gen_random_uuid() is built in from 13). Load it after the
-- exactly-once-webhooks schema (node_modules/exactly-once-webhooks/schema.sql),
-- which creates the idempotency_keys table that the claim goes through.
--
-- One webhook commits, in one transaction: its idempotency key (done), its event
-- row, and one outbox row per outbound step. Nothing outside the database happens
-- in that transaction. The outbound calls are sent afterwards from crm_outbox.

CREATE TABLE IF NOT EXISTS crm_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per outbound call. The sender walks the steps in a fixed order
-- (crm_upsert, then chat_alert) and won't send the alert until the CRM row is sent.
CREATE TABLE IF NOT EXISTS crm_outbox (
  event_id     text NOT NULL REFERENCES crm_events (event_id),
  step         text NOT NULL CHECK (step IN ('crm_upsert', 'chat_alert')),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sending', 'sent', 'dead_lettered')),
  -- A sender holds a row while it calls out. If it dies mid-call, the row is
  -- picked up again once lease_until has passed (so that call can repeat).
  lease_until  timestamptz,
  -- New on every take. A sender may only mark the row sent or dead-lettered while
  -- the token is still its own, so a sender whose lease ran out changes nothing.
  lease_token  uuid,
  sent_at      timestamptz,
  PRIMARY KEY (event_id, step)
);

CREATE INDEX IF NOT EXISTS crm_outbox_unsent_idx
  ON crm_outbox (status) WHERE status IN ('pending', 'sending');

-- One row each time a step runs out of retries. Rows are never deleted; only
-- `replayed` is ever updated.
CREATE TABLE IF NOT EXISTS crm_dead_letters (
  id         bigserial PRIMARY KEY,
  event_id   text NOT NULL REFERENCES crm_events (event_id),
  step       text NOT NULL,
  attempts   int  NOT NULL,
  error      text NOT NULL,
  at         timestamptz NOT NULL,
  replayed   boolean NOT NULL DEFAULT false
);
