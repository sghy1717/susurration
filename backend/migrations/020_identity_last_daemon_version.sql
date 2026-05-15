-- Phase 16 — Track last reported daemon version per identity so dashboard
-- can show "X.Y.Z (latest A.B.C available)" + upgrade banner.
--
-- Daemon reports version via SSE connect User-Agent header
-- (`susurration-agent-daemon/X.Y.Z`). Backend SSE handler extracts + updates
-- this column. dashboard /identity/whoami returns it for client comparison
-- against /api/daemon/latest-version.

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS last_daemon_version text;

INSERT INTO schema_migrations(version) VALUES ('020_identity_last_daemon_version');
