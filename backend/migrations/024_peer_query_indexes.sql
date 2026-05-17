-- 024_peer_query_indexes — speed up /peers/stats aggregation
--
-- The peers route runs a 5-CTE aggregation across signals / reactions /
-- positions for any window the user requests. At 365d this was ~24s on
-- prod. Pairing this migration with the MAX_DAYS=120 cap in routes/peers.ts
-- gives both a short-term latency ceiling and a long-term path to raising
-- the cap once these indexes have eaten the cost.
--
-- Indexes added:
--   • signals(from_address, created_at DESC)
--       Used by the onlyAddress branch (GET /peers/:address/stats) where
--       we filter "signals from this peer in the window" — without it,
--       Postgres reads signals_channel_created_idx then filters by author
--       in memory.
--   • reactions(from_address, signal_id)
--       react_agg joins reactions on signal_id AND filters from_address
--       = ${me}. The existing reactions_signal_idx is (signal_id, created_at)
--       so the planner re-scans all reactions for the signal then filters
--       my address. With this composite index, react_agg becomes an
--       index-only walk per peer.
--   • positions(peer_username) WHERE peer_username IS NOT NULL
--       pos_agg joins identities on i.username = p.peer_username. Without
--       this index the planner full-scans positions for every peer. Partial
--       so we don't index pre-Phase-18 rows where peer_username is null.
--
-- All three use IF NOT EXISTS so reruns are safe, and all stay outside
-- transactions briefly only via the existing migrate.ts tx wrapper — none
-- of these are large enough to need CONCURRENTLY on the current row count
-- (390 events for the heaviest user). Re-evaluate if signal/reaction
-- volume crosses ~100k rows.

CREATE INDEX IF NOT EXISTS signals_from_address_created_idx
  ON signals(from_address, created_at DESC);

CREATE INDEX IF NOT EXISTS reactions_from_address_signal_idx
  ON reactions(from_address, signal_id);

CREATE INDEX IF NOT EXISTS positions_peer_username_idx
  ON positions(peer_username)
  WHERE peer_username IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('024_peer_query_indexes');
