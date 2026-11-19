-- Postgres is the queue. Claim with FOR UPDATE SKIP LOCKED.
-- Complete or update a job only when the fencing token still matches.
-- Outbox states: draft -> approved -> queued -> sending -> sent | failed | unknown | cancelled.
-- unknown is never auto-retried. Approved snapshots are immutable.

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'done', 'failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  tenant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_pending_idx ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id),
  chat_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'draft', 'approved', 'queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled'
  )),
  draft_body text,
  body_snapshot jsonb,
  version int NOT NULL DEFAULT 1,
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  not_before timestamptz,
  telegram_message_id bigint,
  last_error text,
  campaign_id uuid,
  recipient_key text,
  category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_queued_idx ON outbox (created_at) WHERE state = 'queued';

CREATE TABLE outbox_state_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES outbox (id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE TABLE send_pacing (
  bot_id uuid NOT NULL REFERENCES bots (id),
  chat_id text NOT NULL,
  not_before timestamptz,
  PRIMARY KEY (bot_id, chat_id)
);

CREATE OR REPLACE FUNCTION outbox_before_update() RETURNS trigger AS $$
BEGIN
  IF OLD.body_snapshot IS NOT NULL AND NEW.body_snapshot IS DISTINCT FROM OLD.body_snapshot THEN
    RAISE EXCEPTION 'approved snapshot is immutable';
  END IF;
  IF OLD.state = 'unknown' AND NEW.state NOT IN ('unknown', 'sent', 'cancelled') THEN
    RAISE EXCEPTION 'illegal outbox transition % -> %', OLD.state, NEW.state;
  END IF;
  IF OLD.state = 'sent' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'illegal outbox transition % -> %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_before_update_trg
BEFORE UPDATE ON outbox
FOR EACH ROW EXECUTE FUNCTION outbox_before_update();

CREATE OR REPLACE FUNCTION outbox_state_history_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO outbox_state_history (outbox_id, from_state, to_state)
    VALUES (
      NEW.id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END,
      NEW.state
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_state_history_trg
AFTER INSERT OR UPDATE ON outbox
FOR EACH ROW EXECUTE FUNCTION outbox_state_history_fn();
