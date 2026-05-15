-- Phase 14 — Add FK + cascade to paper_positions / daemon_decisions tables.
-- G review (Phase 13) flagged:
--   1. signal_id / channel_id were untyped UUIDs trusting body input
--   2. signal delete (cascade from channel) left orphan paper_positions / daemon_decisions
--   3. fake position injection attack surface (rate-limited but real)
--
-- This migration adds REFERENCES + ON DELETE CASCADE for both tables.
-- Endpoint-side membership check is in routes/paper_positions.ts +
-- routes/daemon_decisions.ts (Phase 14a code change).
--
-- Pre-existing rows: skipped if any orphan FK violations exist; admin should
-- clean orphans before deploy if the constraint fails. Phase 11 ship was
-- recent so production data should be clean.

-- paper_positions: signal_id MUST exist; channel_id MUST exist
ALTER TABLE paper_positions
  ADD CONSTRAINT paper_positions_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(signal_id) ON DELETE CASCADE,
  ADD CONSTRAINT paper_positions_channel_id_fkey
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE;

-- daemon_decisions: signal_id / channel_id are nullable (some events have no
-- triggering signal), use ON DELETE SET NULL to avoid losing decision history
-- when underlying signal/channel disappears.
ALTER TABLE daemon_decisions
  ADD CONSTRAINT daemon_decisions_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(signal_id) ON DELETE SET NULL,
  ADD CONSTRAINT daemon_decisions_channel_id_fkey
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE SET NULL;

INSERT INTO schema_migrations(version) VALUES ('019_paper_positions_fk_and_membership');
