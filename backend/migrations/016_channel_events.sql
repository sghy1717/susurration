-- Phase 10 D7 — Persist channel structural events so /signals/feed REST query
-- includes them, not just SSE live push.
--
-- Without this, page refresh loses the entire channel collaboration history
-- (who joined / who was kicked / who renamed) which directly violates the
-- product core "Feed 流可视化 — 所有协作事件实时可见" standard.
--
-- Why a separate table (not signals): signal/reaction are user-pushed payloads;
-- channel events are structural (server-recorded, no payload from user).
-- Why not events table: events.address_hash is one-way hashed PII; we need
-- user-readable usernames to render "X invited Y to group Z".

CREATE TABLE IF NOT EXISTS channel_events (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      uuid NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  kind            text NOT NULL,
  actor_address   text NOT NULL,
  actor_username  text,
  target_address  text,
  target_username text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_events_channel_id_created_at_idx
  ON channel_events(channel_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('016_channel_events');
