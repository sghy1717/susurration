// Phase 11a — Paper position persistence (cross-device sync source of truth).
//
// Daemon stays source of truth for open/close DECISIONS (uses fresh local
// price + LLM size_factor), server is the authoritative cross-device MIRROR.
// Daemon: POSTs on every open + close → web dashboard / second-device daemon
// reads via GET to rebuild local cache.
//
// Endpoints:
//   POST /paper_positions/open    — daemon called open()
//   POST /paper_positions/close   — daemon called close() (TP/SL/TIME/TRAIL)
//   GET  /paper_positions/mine    — caller's positions (filter by status)
//
// Authoritative dedup: UNIQUE(address, signal_id). Open is idempotent
// (re-POST = no-op via ON CONFLICT). Close is also idempotent (only updates
// closed_at if NULL).

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";

export const paperPositionsRoutes = new Hono();

const SYNC_LIMIT = { windowMs: 60_000, max: 120 };  // daemon may sync many at startup

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  if (e instanceof RateLimitedError) return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
  throw e;
}

function isValidDirection(s: any): s is "long" | "short" {
  return s === "long" || s === "short";
}

paperPositionsRoutes.post("/paper_positions/open", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`paper-pos-open:${me}`, SYNC_LIMIT);
  } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const signal_id = String(body?.signal_id ?? "");
  const channel_id = String(body?.channel_id ?? "");
  const token = String(body?.token ?? "").slice(0, 40);
  const direction = body?.direction;
  const leverage = Number(body?.leverage);
  const entry_price = Number(body?.entry_price);
  const stop_loss = Number(body?.stop_loss);
  const take_profit = Number(body?.take_profit);
  const position_usd = Number(body?.position_usd);
  const size_factor = body?.size_factor != null ? Number(body.size_factor) : null;
  const peer_username = body?.peer_username != null ? String(body.peer_username).slice(0, 40) : null;
  const is_replay = !!body?.is_replay;
  const opened_at = body?.opened_at ? String(body.opened_at) : null;
  const daemon_local_id = body?.daemon_local_id != null ? String(body.daemon_local_id).slice(0, 16) : null;

  if (!signal_id || !channel_id || !token || !isValidDirection(direction)) {
    return c.json({ error: "missing_or_invalid_fields", required: "signal_id, channel_id, token, direction" }, 400);
  }
  for (const [name, v] of [["leverage", leverage], ["entry_price", entry_price], ["stop_loss", stop_loss], ["take_profit", take_profit], ["position_usd", position_usd]] as const) {
    if (!Number.isFinite(v)) return c.json({ error: `${name} must be a finite number` }, 400);
  }

  // Phase 14 G #2 — verify caller is a member of channel + signal exists in
  // that channel. Without this check, anyone with a valid token can flood
  // their own paper_positions table with fake rows referencing arbitrary
  // signal/channel IDs (rate-limited to 17万/day/user but still attack surface).
  // FK on migration 019 catches non-existent signal_id; this catches "valid
  // signal but caller isn't a member of its channel".
  const auth = await sql<{ ok: boolean }[]>`
    SELECT 1::int AS ok
    FROM signals s
    JOIN channel_members cm ON cm.channel_id = s.channel_id AND cm.address = ${me}
    WHERE s.signal_id = ${signal_id} AND s.channel_id = ${channel_id}
    LIMIT 1
  `;
  if (!auth[0]) {
    return c.json({ error: "signal_not_in_caller_channel" }, 403);
  }

  // Idempotent insert — daemon may retry on transient network failure.
  const rows = await sql<{ position_id: string; opened_at: Date }[]>`
    INSERT INTO paper_positions (
      address, signal_id, channel_id, token, direction, leverage,
      entry_price, stop_loss, take_profit, position_usd, size_factor,
      peer_username, is_replay, opened_at, daemon_local_id
    )
    VALUES (
      ${me}, ${signal_id}, ${channel_id}, ${token}, ${direction}, ${leverage},
      ${entry_price}, ${stop_loss}, ${take_profit}, ${position_usd}, ${size_factor},
      ${peer_username}, ${is_replay},
      ${opened_at ? sql`${opened_at}::timestamptz` : sql`now()`},
      ${daemon_local_id}
    )
    ON CONFLICT (address, signal_id) DO NOTHING
    RETURNING position_id, opened_at
  `;

  if (!rows[0]) {
    // Already existed; return existing row's identifiers.
    const existing = await sql<{ position_id: string; opened_at: Date }[]>`
      SELECT position_id, opened_at FROM paper_positions
      WHERE address = ${me} AND signal_id = ${signal_id}
    `;
    return c.json({
      ok: true,
      idempotent: true,
      position_id: existing[0]?.position_id,
      opened_at: existing[0]?.opened_at?.toISOString(),
    });
  }
  return c.json({
    ok: true,
    position_id: rows[0].position_id,
    opened_at: rows[0].opened_at.toISOString(),
  });
});

paperPositionsRoutes.post("/paper_positions/close", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`paper-pos-close:${me}`, SYNC_LIMIT);
  } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const signal_id = String(body?.signal_id ?? "");
  const exit_reason = String(body?.exit_reason ?? "");
  const exit_price = Number(body?.exit_price);
  const exit_pnl_pct = Number(body?.exit_pnl_pct);
  const exit_pnl_usd = body?.exit_pnl_usd != null ? Number(body.exit_pnl_usd) : null;
  const closed_at = body?.closed_at ? String(body.closed_at) : null;

  const VALID_REASONS = ["TP", "SL", "TIME", "TRAIL", "MANUAL", "stop_loss", "take_profit", "time_stop", "trailing_stop"];
  if (!signal_id) return c.json({ error: "signal_id required" }, 400);
  if (!VALID_REASONS.includes(exit_reason)) {
    return c.json({ error: `exit_reason must be one of ${VALID_REASONS.join(", ")}` }, 400);
  }
  if (!Number.isFinite(exit_price) || !Number.isFinite(exit_pnl_pct)) {
    return c.json({ error: "exit_price and exit_pnl_pct must be finite numbers" }, 400);
  }

  // Idempotent — only updates if not yet closed.
  const rows = await sql<{ position_id: string }[]>`
    UPDATE paper_positions
    SET closed_at = ${closed_at ? sql`${closed_at}::timestamptz` : sql`now()`},
        exit_reason = ${exit_reason},
        exit_price = ${exit_price},
        exit_pnl_pct = ${exit_pnl_pct},
        exit_pnl_usd = ${exit_pnl_usd}
    WHERE address = ${me} AND signal_id = ${signal_id} AND closed_at IS NULL
    RETURNING position_id
  `;
  if (!rows[0]) {
    // Either position doesn't exist or already closed — both treated as no-op.
    return c.json({ ok: true, idempotent: true });
  }
  return c.json({ ok: true, position_id: rows[0].position_id });
});

paperPositionsRoutes.get("/paper_positions/mine", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const status = c.req.query("status") ?? "all";
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);

  let rows;
  if (status === "open") {
    rows = await sql`
      SELECT * FROM paper_positions
      WHERE address = ${me} AND closed_at IS NULL
      ORDER BY opened_at DESC LIMIT ${limit}
    `;
  } else if (status === "closed") {
    rows = await sql`
      SELECT * FROM paper_positions
      WHERE address = ${me} AND closed_at IS NOT NULL
      ORDER BY closed_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM paper_positions
      WHERE address = ${me}
      ORDER BY opened_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ positions: rows });
});
