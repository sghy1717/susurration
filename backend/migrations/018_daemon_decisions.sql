-- Phase 11b — Persist daemon decisions (full row, not hashed) so users can
-- see their full decision history from any device + diagnose silent daemon
-- (装了不工作) on the user side, not just admin.
--
-- Distinct from `events.daemon_decision` (which is hashed-PII analytics).
-- This table is user-readable: caller can GET their own decisions including
-- LLM reasoning_summary (capped 500 chars). Privacy: caller-only access by
-- design (no public listing of others' reasoning).

CREATE TABLE IF NOT EXISTS daemon_decisions (
  decision_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address            text NOT NULL,
  signal_id          uuid,            -- triggering signal (NULL for some events)
  channel_id         uuid,
  kind               text NOT NULL,   -- react / push / noop / error
  reaction_id        uuid,            -- when kind=react, the resulting reaction
  event_kind         text,            -- triggering event type (signal/reaction)
  llm_provider       text,
  llm_model          text,
  latency_ms         int,
  error_type         text,            -- expired/rate_limited/llm_paused/llm_auth_error/llm_quota_error/llm_error/execute_failed
  reasoning_summary  text,            -- LLM short reason (cap 500 chars)
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daemon_decisions_address_created_at_idx
  ON daemon_decisions(address, created_at DESC);

CREATE INDEX IF NOT EXISTS daemon_decisions_signal_id_idx
  ON daemon_decisions(signal_id) WHERE signal_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('018_daemon_decisions');
