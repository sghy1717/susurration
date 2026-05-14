-- One-time cleanup: position_closes had wrong data from the frontend-only
-- close detection that was broken (authedAddress auth bug). Server-side
-- position_closer now handles all close detection.
DELETE FROM position_closes;

INSERT INTO schema_migrations(version) VALUES ('015_position_closes_cleanup');
