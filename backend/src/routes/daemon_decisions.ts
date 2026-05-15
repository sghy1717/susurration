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
  if (!["react", "push", "noop", "error"].includes(kind)) {
    return c.json({ error: "kind must be one of: react, push, noop, error" }, 400);
  }
  const signal_id = body?.signal_id != null ? String(body.signal_id).slice(0, 64) : null;
  const channel_id = body?.channel_id != null ? String(body.channel_id).slice(0, 64) : null;
  const reaction_id = body?.reaction_id != null ? String(body.reaction_id).slice(0, 64) : null;
  const event_kind = body?.event_kind != null ? String(body.event_kind).slice(0, 40) : null;
  const llm_provider = body?.llm_provider != null ? String(body.llm_provider).slice(0, 40) : null;
  const llm_model = body?.llm_model != null ? String(body.llm_model).slice(0, 60) : null;
  const latency_ms = Number.isFinite(Number(body?.latency_ms)) ? Math.floor(Number(body.latency_ms)) : null;
  const error_type = body?.error_type != null ? String(body.error_type).slice(0, 40) : null;
  // Cap reasoning_summary at 500 chars — user opt-in via daemon config
  // share_reasoning_with_server: true (default). Storing here means cross-device
  // visibility but server can read.
  const reasoning_summary = body?.reasoning_summary != null
    ? String(body.reasoning_summary).slice(0, 500) : null;
  const created_at = body?.created_at ? String(body.created_at) : null;

  const rows = await sql<{ decision_id: string }[]>`
    INSERT INTO daemon_decisions (
      address, signal_id, channel_id, kind, reaction_id, event_kind,
      llm_provider, llm_model, latency_ms, error_type, reasoning_summary, created_at
    )
    VALUES (
      ${me}, ${signal_id}, ${channel_id}, ${kind}, ${reaction_id}, ${event_kind},
      ${llm_provider}, ${llm_model}, ${latency_ms}, ${error_type}, ${reasoning_summary},
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
