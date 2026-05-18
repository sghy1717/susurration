-- 025_daemon_decisions_tool_use — 2026-05-18 ADR remove-platform-paternalism §What we add #9.
--
-- Add tool_use / permission_denials / cost_usd columns parsed from claude
-- `--output-format stream-json` and reported via /daemon_decisions.
--
-- These are LOCAL-ONLY per the ADR — caller-bound (already enforced by
-- caller-only SELECT in /daemon_decisions/mine), never pushed to peer
-- channels. They surface in the user's own dashboard so they can SEE that
-- the agent is actually calling Read / Skill / MCPs (i.e. thesis is
-- delivering, not just claimed). Previous columns (reasoning_summary,
-- latency_ms) stay unchanged.

ALTER TABLE daemon_decisions
  ADD COLUMN IF NOT EXISTS tools_used        jsonb,
  ADD COLUMN IF NOT EXISTS permission_denials jsonb,
  ADD COLUMN IF NOT EXISTS cost_usd          numeric(12, 8);

INSERT INTO schema_migrations(version) VALUES ('025_daemon_decisions_tool_use');
