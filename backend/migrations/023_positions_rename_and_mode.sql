-- Phase 18.2 — Rename paper_positions → positions and introduce dual-mode
-- (paper / live) bookkeeping.
--
-- Why:
--   Phase 18 turned the daemon into a thin spawner for the user's IDE-agent
--   (Claude Code / Codex). The agent decides; susurration logs the decision.
--   Previously every position record was simulated, so `paper_positions` was
--   accurate. Now the same agent may execute live trades through the user's
--   own broker MCP and report the fill back via susu_position_open. The table
--   stores both; the name has to follow.
--
--   `mode` distinguishes paper from live so the dashboard can show two
--   equity curves on the same screen.
--
--   `broker_position_id` lets a live record carry the broker's order ID so
--   the agent's later close report can be reconciled against the open.
--
-- Compatibility:
--   • Tx-wrapped by the runner (migrate.ts) so partial state is impossible.
--   • All existing rows are inferred `mode = 'paper'` via the column default.
--     Pre-Phase-18 daemons only wrote paper anyway.
--   • Old daemons (<= 0.0.20) hitting POST /paper_positions/* will see 404
--     after the route prefix flips to /positions/* in the same release.
--     Acceptable: pre-launch user base = 1, and the old daemon is being
--     replaced in the same Phase 18.2 ship.

ALTER TABLE paper_positions RENAME TO positions;

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS mode               text NOT NULL DEFAULT 'paper'
                          CHECK (mode IN ('paper', 'live')),
  ADD COLUMN IF NOT EXISTS broker_position_id text;

-- Rename existing indexes so \d output stays readable. Index names are not
-- referenced by application code, so this is cosmetic but worth doing.
ALTER INDEX paper_positions_address_opened_at_idx
  RENAME TO positions_address_opened_at_idx;
ALTER INDEX paper_positions_address_open_idx
  RENAME TO positions_address_open_idx;

-- Rename constraints likewise (PK + FKs + unique). Constraint names are
-- only surfaced in error messages, but they should at least mention the
-- correct table.
ALTER TABLE positions
  RENAME CONSTRAINT paper_positions_pkey TO positions_pkey;
ALTER TABLE positions
  RENAME CONSTRAINT paper_positions_signal_id_fkey TO positions_signal_id_fkey;
ALTER TABLE positions
  RENAME CONSTRAINT paper_positions_channel_id_fkey TO positions_channel_id_fkey;
-- The UNIQUE (address, signal_id) in 017_paper_positions.sql is implicit, so
-- Postgres auto-named it paper_positions_address_signal_id_key.
ALTER TABLE positions
  RENAME CONSTRAINT paper_positions_address_signal_id_key TO positions_address_signal_id_key;

-- Useful index for `WHERE mode = 'live' AND closed_at IS NULL`, which the
-- live-position monitor loop will run every poll.
CREATE INDEX IF NOT EXISTS positions_address_mode_open_idx
  ON positions(address, mode) WHERE closed_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('023_positions_rename_and_mode');
