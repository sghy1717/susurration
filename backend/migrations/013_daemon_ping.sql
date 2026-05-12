ALTER TABLE identities ADD COLUMN IF NOT EXISTS last_daemon_ping_at TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('013_daemon_ping');
