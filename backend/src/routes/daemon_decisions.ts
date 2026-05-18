// Phase 11b — Daemon decision persistence (cross-device + user-visible).
//
// Distinct from /daemon/decision (events.ts hashed-PII analytics):
// - /daemon/decision: anonymous-hashed for funnel / silent-daemon detection
// - /daemon_decisions:    plaintext caller-bound, queryable by caller
//
// Daemon should write to BOTH (parallel paths) until next major; old
// /daemon/decision can be deprecated later. New endpoint is what dashboards
// use to render "Agent decisions" timeline.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";

export const daemonDecisionsRoutes = new Hono();

const WRITE_LIMIT = { windowMs: 60_000, max: 120 };

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  if (e instanceof RateLimitedError) return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
  throw e;
}

daemonDecisionsRoutes.post("/daemon_decisions", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`daemon-dec-write:${me}`, WRITE_LIMIT);
  } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const kind = String(body?.kind ?? "").slice(0, 20);
  // 2026-05-18 G review #1 — `invoke` is the post-Phase-18 main happy-path
  // kind (daemon dispatched an IDE-agent run; the agent's actual choice is
  // captured separately on backend signals/reactions). Without "invoke"
  // in this whitelist, EVERY successful dispatch 400'd silently (daemon
  // fire-and-forget catches the error) and ADR §What we add #10 dashboard
  // surfaces (onboarding tour step 4, AgentStatePanel "last successful
  // run" + "tools called") never lit up.
  if (!["react", "push", "noop", "error", "invoke"].includes(kind)) {
    return c.json({ error: "kind must be one of: react, push, noop, error, invoke" }, 400);
  }
  const signal_id = body?.signal_id != null ? String(body.signal_id).slice(0, 64) : null;
  const channel_id = body?.channel_id != null ? String(body.channel_id).slice(0, 64) : null;
  const reaction_id = body?.reaction_id != null ? String(body.reaction_id).slice(0, 64) : null;
  const event_kind = body?.event_kind != null ? String(body.event_kind).slice(0, 40) : null;
  const llm_provider = body?.llm_provider != null ? String(body.llm_provider).slice(0, 40) : null;
  const llm_model = body?.llm_model != null ? String(body.llm_model).slice(0, 60) : null;
  const latency_ms = Number.isFinite(Number(body?.latency_ms)) ? Math.floor(Number(body.latency_ms)) : null;
  const error_type = body?.error_type != null ? String(body.error_type).slice(0, 40) : null;
  // 2026-05-18 G review P0 #3 fix — share_reasoning_summary defaults to
  // TRUE (Phase 15 product decision), set to FALSE in agent-config.json
  // to keep LLM reasoning strictly in ~/.susu/agent-decisions.jsonl.
  // Server stores whatever arrives, capped 500 chars defensively;
  // disclosure is enforced client-side in agent-daemon, not here.
  // (Old comment claimed opt-IN default false, but daemon code never
  // actually gated on the flag — sent unconditionally. Fixed in
  // daemon 0.0.27.)
  const reasoning_summary = body?.reasoning_summary != null
    ? String(body.reasoning_summary).slice(0, 500) : null;
  const created_at = body?.created_at ? String(body.created_at) : null;

  // 2026-05-18 ADR remove-platform-paternalism §What we add #9 — parsed
  // from claude stream-json. CALLER-ONLY by the SELECT ACL on
  // /daemon_decisions/mine; never pushed to peer channels. We store as
  // JSONB without prying into shape; daemon caps payload size before send.
  const tools_used = body?.tools_used != null ? body.tools_used : null;
  const permission_denials = body?.permission_denials != null ? body.permission_denials : null;
  const cost_usd = Number.isFinite(Number(body?.cost_usd)) ? Number(body.cost_usd) : null;
  // Defensive size cap: refuse absurd payloads (avoids a misconfigured
  // daemon writing megabytes per decision). Shape isn't validated.
  if (tools_used != null) {
    const s = JSON.stringify(tools_used);
    if (s.length > 32_000) {
      return c.json({ error: "tools_used too large (max 32KB)" }, 400);
    }
  }
  if (permission_denials != null) {
    const s = JSON.stringify(permission_denials);
    if (s.length > 8_000) {
      return c.json({ error: "permission_denials too large (max 8KB)" }, 400);
    }
  }

  // Phase 14 G #2 — if signal_id provided, verify caller is in that signal's
  // channel. Without check, attacker can write decisions referencing any
  // signal id. signal_id is nullable (e.g. error events with no source) so
  // skip check when null.
  if (signal_id) {
    const auth = await sql<{ ok: boolean }[]>`
      SELECT 1::int AS ok
      FROM signals s
      JOIN channel_members cm ON cm.channel_id = s.channel_id AND cm.address = ${me}
      WHERE s.signal_id = ${signal_id}
      LIMIT 1
    `;
    if (!auth[0]) {
      return c.json({ error: "signal_not_in_caller_channel" }, 403);
    }
  }

  const rows = await sql<{ decision_id: string }[]>`
    INSERT INTO daemon_decisions (
      address, signal_id, channel_id, kind, reaction_id, event_kind,
      llm_provider, llm_model, latency_ms, error_type, reasoning_summary,
      tools_used, permission_denials, cost_usd, created_at
    )
    VALUES (
      ${me}, ${signal_id}, ${channel_id}, ${kind}, ${reaction_id}, ${event_kind},
      ${llm_provider}, ${llm_model}, ${latency_ms}, ${error_type}, ${reasoning_summary},
      ${tools_used != null ? sql`${tools_used}::jsonb` : null},
      ${permission_denials != null ? sql`${permission_denials}::jsonb` : null},
      ${cost_usd},
      ${created_at ? sql`${created_at}::timestamptz` : sql`now()`}
    )
    RETURNING decision_id
  `;
  return c.json({ ok: true, decision_id: rows[0]?.decision_id });
});

daemonDecisionsRoutes.get("/daemon_decisions/mine", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const since = c.req.query("since");
  const kind = c.req.query("kind");
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);

  let rows;
  if (since && kind) {
    rows = await sql`
      SELECT * FROM daemon_decisions
      WHERE address = ${me} AND created_at > ${since}::timestamptz AND kind = ${kind}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (since) {
    rows = await sql`
      SELECT * FROM daemon_decisions
      WHERE address = ${me} AND created_at > ${since}::timestamptz
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else if (kind) {
    rows = await sql`
      SELECT * FROM daemon_decisions
      WHERE address = ${me} AND kind = ${kind}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM daemon_decisions
      WHERE address = ${me}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ decisions: rows });
});
