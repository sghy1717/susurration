-- Phase 11a — Persist daemon-opened paper positions to server so users can
-- see their full trade history from any device (not just the machine running
-- the daemon). Daemon remains source of truth for the open/close decision
-- (uses fresh local price), server is a cross-device mirror.
--
-- Replaces partial-coverage `position_closes` table (014/015) which only
-- recorded close events; this table is the authoritative open + close record.
-- Old position_closes data stays for backward compat; new daemons write here.

CREATE TABLE IF NOT EXISTS paper_positions (
  position_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address          text NOT NULL,
  signal_id        uuid NOT NULL,
  channel_id       uuid NOT NULL,
  token            text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('long', 'short')),
  leverage         int  NOT NULL,
  entry_price      double precision NOT NULL,
  stop_loss        double precision NOT NULL,
  take_profit      double precision NOT NULL,
  position_usd     double precision NOT NULL,
  size_factor      double precision,
  peer_username    text,
  is_replay        boolean NOT NULL DEFAULT false,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  exit_reason      text,
  exit_price       double precision,
  exit_pnl_pct     double precision,
  exit_pnl_usd     double precision,
  daemon_local_id  text,             -- daemon's local sequential id (for dedup)
  UNIQUE (address, signal_id)        -- one position per signal per user
);

CREATE INDEX IF NOT EXISTS paper_positions_address_opened_at_idx
  ON paper_positions(address, opened_at DESC);

CREATE INDEX IF NOT EXISTS paper_positions_address_open_idx
  ON paper_positions(address) WHERE closed_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('017_paper_positions');
