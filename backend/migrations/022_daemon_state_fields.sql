-- Phase 17 — Daemon state surface for dashboard.
-- Web dashboard's "Agent state" panel needs daemon-side config snapshot
-- (provider / execution mode / broker connection / conviction threshold /
-- max size factor) so the human owner can see what their agent is configured
-- to do without SSHing into the daemon host.
--
-- Daemon will POST /identity/daemon-ping with this snapshot on startup and
-- every ~30 minutes. Fields default to NULL so older daemons (no patch)
-- show "—" in the UI rather than incorrect defaults.

-- execution_mode: 'paper' (active paper trading) / 'live' (broker-connected live)
--                 / NULL (paper trading disabled or daemon never reported)
-- min_size_factor: the floor below which the daemon will not open a position
--                  (named to match daemon config — NOT a max cap).
ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS daemon_provider           text,
  ADD COLUMN IF NOT EXISTS daemon_execution_mode     text,
  ADD COLUMN IF NOT EXISTS daemon_broker_connected   boolean,
  ADD COLUMN IF NOT EXISTS daemon_conv_threshold     double precision,
  ADD COLUMN IF NOT EXISTS daemon_min_size_factor    double precision,
  ADD COLUMN IF NOT EXISTS daemon_started_at         timestamptz;

INSERT INTO schema_migrations(version) VALUES ('022_daemon_state_fields');
