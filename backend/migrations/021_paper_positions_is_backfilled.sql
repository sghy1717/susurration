-- Phase 17.5 — Mark rows that came from one-shot historical backfill (Phase
-- 17.5 A) rather than from real-time daemon sync.
--
-- WHY: pre-Phase-11a (< daemon 0.0.15) closes were written only to
-- position_closes table, with NO entry context (no entry_price, leverage,
-- position_usd, size_factor, peer_username, channel_id). A backfill script
-- (scripts/backfill_paper_positions.mjs) reconstructs these closes by
-- JOINing position_closes + signals.payload, but several fields can only
-- be guessed (leverage fallback=3) or are unrecoverable (position_usd,
-- size_factor → NULL).
--
-- Dashboard renders is_backfilled=true rows with a "*历史推断*" / "*inferred*"
-- tag so users don't confuse "real entry price" with "guessed entry price"
-- when reviewing agent decision quality.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS is_backfilled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_paper_positions_is_backfilled
  ON paper_positions(address, is_backfilled) WHERE is_backfilled = true;

INSERT INTO schema_migrations(version) VALUES ('021_paper_positions_is_backfilled');
