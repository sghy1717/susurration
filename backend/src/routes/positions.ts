// Phase 18.2 — Positions (paper + live) lifecycle endpoints.
//
// Susurration is the audit log for agent trading decisions. Each row in the
// `positions` table is one decision the agent acted on; `mode` distinguishes
// paper (susurration's built-in simulator) from live (the user's broker, the
// agent reports back via susu_position_open).
//
// Endpoint surface:
//   POST /signals/:id/accept            — atomic: log reaction(+1) + open
//                                         position. The "agent agrees, take
//                                         the trade" primitive. mode=paper
//                                         (default) or "live" with broker_*.
//   POST /signals/:id/reject            — log reaction(-1). No position.
//   POST /positions/:position_id/close  — close by position id (preferred for
//                                         agents acting on live broker fills).
//   POST /positions/close               — close by signal_id (legacy path
//                                         used by PaperTrader/PaperCloseQueue
//                                         which key on signal_id).
//   POST /positions/open                — direct open (no reaction). Kept for
//                                         paper sync replay; new agent flow
//                                         should use /signals/:id/accept.
//   GET  /positions/mine                — caller's positions, optional
//                                         status/mode filters.
//
// Idempotency:
//   • Open is idempotent on UNIQUE(address, signal_id). Re-POST returns the
//     existing row.
//   • Close is idempotent on closed_at IS NULL. Re-POST returns ok no-op.
//   • Accept is open+reaction together; the open is idempotent so retrying
//     after a partial failure converges to one position + one reaction row.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { parseJsonBody } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { meter, InsufficientAllowanceError } from "../billing.ts";
import { deliverToChannelMembers } from "../lib/webhook.ts";
import { publishChannel } from "./signals.ts";
import { buildAllowanceResponse } from "./billing.ts";
import { recordEvent } from "../lib/events.ts";

export const positionsRoutes = new Hono();

const SYNC_LIMIT = { windowMs: 60_000, max: 120 };  // daemon may sync many at startup
const ACCEPT_LIMIT = { windowMs: 60_000, max: 60 }; // matches signal-reaction cap
const REJECT_LIMIT = { windowMs: 60_000, max: 120 };

const VALID_MODES = ["paper", "live"] as const;
type Mode = (typeof VALID_MODES)[number];

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  if (e instanceof RateLimitedError) return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
  throw e;
}

function isValidDirection(s: any): s is "long" | "short" {
  return s === "long" || s === "short";
}

function isValidMode(s: any): s is Mode {
  return s === "paper" || s === "live";
}

// Shared validator for an opening payload (signal-anchored row).
// Returns either {ok:true, fields} or a Response to return immediately.
async function validateOpenFields(c: any, body: any, me: string) {
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
  const mode: Mode = isValidMode(body?.mode) ? body.mode : "paper";
  const broker_position_id = body?.broker_position_id != null
    ? String(body.broker_position_id).slice(0, 64) : null;

  if (!signal_id || !channel_id || !token || !isValidDirection(direction)) {
    return c.json({ error: "missing_or_invalid_fields", required: "signal_id, channel_id, token, direction" }, 400);
  }
  for (const [name, v] of [["leverage", leverage], ["entry_price", entry_price], ["stop_loss", stop_loss], ["take_profit", take_profit], ["position_usd", position_usd]] as const) {
    if (!Number.isFinite(v)) return c.json({ error: `${name} must be a finite number` }, 400);
  }
  // Phase 18.2 — when mode="live" the agent has already placed an order with
  // a real broker. We require broker_position_id so the later
  // susu_position_close can be reconciled against the actual broker order. A
  // live row without a broker id would be stranded — the live monitor would
  // keep waking the agent for it forever with no way to match the close.
  // (G review #3.) JSON Schema can't enforce conditional-required, so the
  // gate lives here.
  if (mode === "live" && !broker_position_id) {
    return c.json({
      error: "broker_position_id_required_for_live",
      hint: "When opening a position with mode=\"live\", broker_position_id must be the broker's order or position id so future closes can be reconciled. If the broker did not return an id, place the trade as mode=\"paper\" or skip the open.",
    }, 400);
  }

  // Phase 14 G #2 — verify caller is a member of channel + signal exists in
  // that channel. Without this check, anyone with a valid token can flood
  // their own positions table with fake rows referencing arbitrary
  // signal/channel IDs (rate-limited but still attack surface).
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

  return {
    ok: true as const,
    fields: {
      signal_id, channel_id, token, direction, leverage, entry_price,
      stop_loss, take_profit, position_usd, size_factor, peer_username,
      is_replay, opened_at, daemon_local_id, mode, broker_position_id,
    },
  };
}

// Insert or fetch existing position. Idempotent on UNIQUE(address, signal_id).
async function upsertPosition(me: string, f: any): Promise<{ position_id: string; opened_at: Date; existing: boolean }> {
  // Same peer_username fallback as /signals/:id/accept — paper-sync replays
  // and legacy daemon direct opens also tend to omit this field. One extra
  // SELECT per write keeps the dashboard's "From" column honest.
  let peer_username = f.peer_username;
  if (peer_username == null) {
    const author = await sql<{ username: string | null }[]>`
      SELECT i.username
      FROM signals s
      LEFT JOIN identities i ON i.address = s.from_address
      WHERE s.signal_id = ${f.signal_id}
      LIMIT 1
    `;
    peer_username = author[0]?.username ?? null;
  }
  const rows = await sql<{ position_id: string; opened_at: Date }[]>`
    INSERT INTO positions (
      address, signal_id, channel_id, token, direction, leverage,
      entry_price, stop_loss, take_profit, position_usd, size_factor,
      peer_username, is_replay, opened_at, daemon_local_id, mode,
      broker_position_id
    )
    VALUES (
      ${me}, ${f.signal_id}, ${f.channel_id}, ${f.token}, ${f.direction}, ${f.leverage},
      ${f.entry_price}, ${f.stop_loss}, ${f.take_profit}, ${f.position_usd}, ${f.size_factor},
      ${peer_username}, ${f.is_replay},
      ${f.opened_at ? sql`${f.opened_at}::timestamptz` : sql`now()`},
      ${f.daemon_local_id}, ${f.mode}, ${f.broker_position_id}
    )
    ON CONFLICT (address, signal_id) DO NOTHING
    RETURNING position_id, opened_at
  `;
  if (rows[0]) return { ...rows[0], existing: false };
  const existing = await sql<{ position_id: string; opened_at: Date }[]>`
    SELECT position_id, opened_at FROM positions
    WHERE address = ${me} AND signal_id = ${f.signal_id}
  `;
  const e = existing[0]!;
  return { position_id: e.position_id, opened_at: e.opened_at, existing: true };
}

// ── /signals/:id/accept ─────────────────────────────────────────────────
// Atomic semantic: agent agrees with this signal, take the trade. Server
// writes BOTH a reaction(+1) row in `reactions` and a row in `positions` in
// the same transaction so the audit log + position book stay aligned.
//
// The reaction-side behaviour mirrors POST /signals/:id/reactions
// (signals.ts:1000): same meter call, same SSE broadcast, same allowance
// payload, so feed rendering is identical to a manual react. The position
// side adds mode + broker_position_id.
positionsRoutes.post("/signals/:signal_id/accept", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`accept:${me}`, ACCEPT_LIMIT);
  } catch (e) { return authError(c, e); }

  const signal_id_param = c.req.param("signal_id");
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  // The URL param wins over any body field to avoid mismatched-signal bugs.
  body.signal_id = signal_id_param;

  const v = await validateOpenFields(c, body, me);
  if (!("ok" in v)) return v;

  const size_factor = body?.size_factor != null ? Number(body.size_factor) : null;
  const is_auto = body?.is_auto !== false;
  const note = body?.note != null ? String(body.note).slice(0, 280) : null;

  // Reaction payload paired with this open. value=+1 + size_factor encode the
  // trading contract; note is human-facing; mode lets the dashboard render a
  // [LIVE] tag without going back to the positions table.
  const reactionPayload: Record<string, unknown> = {
    value: "+1",
    size_factor,
    mode: v.fields.mode,
    note,
  };

  type AcceptTxResult = {
    reaction_id: string;
    reaction_created_at: Date;
    position_id: string;
    opened_at: Date;
    existing_position: boolean;
    cost_usd: number;
    from_username: string | null;
  };

  let txResult: AcceptTxResult;
  try {
    txResult = await sql.begin<AcceptTxResult>(async (tx) => {
      const reactionRows = await tx<{ reaction_id: string; created_at: Date }[]>`
        INSERT INTO reactions (signal_id, from_address, payload, is_auto)
        VALUES (${v.fields.signal_id}, ${me}, ${tx.json(reactionPayload as any)}, ${is_auto})
        RETURNING reaction_id, created_at
      `;
      const reaction_id = reactionRows[0]!.reaction_id;
      const reaction_created_at = reactionRows[0]!.created_at;

      // Fall back to the signal author for peer_username when the caller
      // didn't supply one. The MCP `susu_signal_accept` tool passes whatever
      // the IDE-agent populates, and agents rarely track per-signal
      // authorship — they just hand the signal back to be accepted. Without
      // this fallback the dashboard's "From" column on the position row
      // ends up empty (?), even though signals.from_address is right there
      // to be joined. One extra SELECT per accept is cheap; the
      // alternative is a periodic janitor query, which we used to backfill
      // 62 historical rows on 2026-05-17.
      let peer_username_resolved = v.fields.peer_username;
      if (peer_username_resolved == null) {
        const author = await tx<{ username: string | null }[]>`
          SELECT i.username
          FROM signals s
          LEFT JOIN identities i ON i.address = s.from_address
          WHERE s.signal_id = ${v.fields.signal_id}
          LIMIT 1
        `;
        peer_username_resolved = author[0]?.username ?? null;
      }

      // Phase 18.2 (G review #4) — DB writes first, on-chain charge LAST so
      // any reversible failure path leaves the user uncharged. meter() calls
      // chargeUser → on-chain SPL transfer, which is not rollbackable; if it
      // succeeds and the tx then fails to commit, we end up with an orphan
      // charge. Putting meter last shrinks that window to the postgres
      // commit-ack moment only.
      const inserted = await tx<{ position_id: string; opened_at: Date }[]>`
        INSERT INTO positions (
          address, signal_id, channel_id, token, direction, leverage,
          entry_price, stop_loss, take_profit, position_usd, size_factor,
          peer_username, is_replay, opened_at, daemon_local_id, mode,
          broker_position_id
        )
        VALUES (
          ${me}, ${v.fields.signal_id}, ${v.fields.channel_id}, ${v.fields.token},
          ${v.fields.direction}, ${v.fields.leverage},
          ${v.fields.entry_price}, ${v.fields.stop_loss}, ${v.fields.take_profit},
          ${v.fields.position_usd}, ${v.fields.size_factor},
          ${peer_username_resolved}, ${v.fields.is_replay},
          ${v.fields.opened_at ? tx`${v.fields.opened_at}::timestamptz` : tx`now()`},
          ${v.fields.daemon_local_id}, ${v.fields.mode}, ${v.fields.broker_position_id}
        )
        ON CONFLICT (address, signal_id) DO NOTHING
        RETURNING position_id, opened_at
      `;
      let position_id: string;
      let opened_at: Date;
      let existing_position: boolean;
      const ins0 = inserted[0];
      if (ins0) {
        position_id = ins0.position_id;
        opened_at = ins0.opened_at;
        existing_position = false;
      } else {
        const ex = await tx<{ position_id: string; opened_at: Date }[]>`
          SELECT position_id, opened_at FROM positions
          WHERE address = ${me} AND signal_id = ${v.fields.signal_id}
        `;
        const ex0 = ex[0]!;
        position_id = ex0.position_id;
        opened_at = ex0.opened_at;
        existing_position = true;
      }

      const u = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${me}
      `;
      const from_username = u[0]?.username ?? null;

      // On-chain charge last. If this fails (insufficient allowance / RPC
      // error / etc.) the whole tx rolls back: no reaction, no position,
      // no charge. Idempotent retries from the client are safe.
      const meterOut = await meter({
        tx,
        address: me,
        channelId: v.fields.channel_id,
        signalId: v.fields.signal_id,
        reactionId: reaction_id,
        callType: "reaction_push",
      });

      return {
        reaction_id,
        reaction_created_at,
        position_id,
        opened_at,
        existing_position,
        cost_usd: meterOut.cost_usd,
        from_username,
      };
    });
  } catch (err: any) {
    if (err instanceof InsufficientAllowanceError) {
      recordEvent({ type: "charge_failed", address: me, payload: { reason: "insufficient_allowance" } });
      return c.json({
        error: "insufficient_allowance",
        free_credits_exhausted: true,
        allowance_usd: err.allowance_usd,
        required_usd: err.required_usd,
        approve_again_url: "https://susurration.xyz/approve?amount=100",
      }, 402);
    }
    return c.json({ error: "accept_failed", detail: String(err?.message ?? err).slice(0, 200) }, 500);
  }

  // Broadcast reaction to channel watchers (parity with signals.ts react path).
  const reactionEvent = {
    kind: "reaction" as const,
    reaction_id: txResult.reaction_id,
    signal_id: v.fields.signal_id,
    channel_id: v.fields.channel_id,
    from_address: me,
    from_username: txResult.from_username,
    payload: reactionPayload,
    is_auto,
    created_at: txResult.reaction_created_at.toISOString(),
  };
  publishChannel(v.fields.channel_id, reactionEvent);
  deliverToChannelMembers(v.fields.channel_id, me, reactionEvent);

  recordEvent({ type: "reaction_push", address: me, channelId: v.fields.channel_id, payload: { is_auto, source: "accept" } });
  void sql`UPDATE identities SET last_active_at = now() WHERE address = ${me}`.catch(() => {});

  const allowance_after = await buildAllowanceResponse(me);
  return c.json({
    ok: true,
    idempotent: txResult.existing_position,
    reaction_id: txResult.reaction_id,
    position_id: txResult.position_id,
    opened_at: txResult.opened_at.toISOString(),
    mode: v.fields.mode,
    cost_usd: txResult.cost_usd,
    allowance_after,
  }, 201);
});

// ── /signals/:id/reject ─────────────────────────────────────────────────
// Agent declines this signal. Logs reaction(-1) with note in `reactions`.
// No position write. Reuses the reaction insert + meter + broadcast pattern
// from signals.ts:1000 to keep dashboard rendering identical to a manual
// react.
positionsRoutes.post("/signals/:signal_id/reject", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`reject:${me}`, REJECT_LIMIT);
  } catch (e) { return authError(c, e); }

  const signal_id = c.req.param("signal_id");
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const note = body?.note != null ? String(body.note).slice(0, 280) : null;
  const is_auto = body?.is_auto !== false;
  const reactionPayload = { value: "-1", note };

  type RejectTxResult = {
    reaction_id: string;
    created_at: Date;
    channel_id: string;
    from_username: string | null;
    cost_usd: number;
  };

  let txResult: RejectTxResult;
  try {
    txResult = await sql.begin<RejectTxResult>(async (tx) => {
      const sigRows = await tx<{ channel_id: string }[]>`
        SELECT channel_id FROM signals WHERE signal_id = ${signal_id}
      `;
      if (!sigRows[0]) throw new Error("signal_not_found");
      const channel_id = sigRows[0].channel_id;

      const memberRows = await tx<{ ok: number }[]>`
        SELECT 1::int AS ok FROM channel_members
        WHERE channel_id = ${channel_id} AND address = ${me} LIMIT 1
      `;
      if (!memberRows[0]) throw new Error("not_a_member");

      const reactionRows = await tx<{ reaction_id: string; created_at: Date }[]>`
        INSERT INTO reactions (signal_id, from_address, payload, is_auto)
        VALUES (${signal_id}, ${me}, ${tx.json(reactionPayload as any)}, ${is_auto})
        RETURNING reaction_id, created_at
      `;
      const reaction_id = reactionRows[0]!.reaction_id;
      const created_at = reactionRows[0]!.created_at;

      const u = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${me}
      `;
      const from_username = u[0]?.username ?? null;

      // Phase 18.2 (G review #4) — meter last so the on-chain charge only
      // happens after all DB writes are queued. If charge fails, tx rolls
      // back and no reaction row gets persisted.
      const meterOut = await meter({
        tx,
        address: me,
        channelId: channel_id,
        signalId: signal_id,
        reactionId: reaction_id,
        callType: "reaction_push",
      });

      return { reaction_id, created_at, channel_id, from_username, cost_usd: meterOut.cost_usd };
    });
  } catch (err: any) {
    if (err instanceof InsufficientAllowanceError) {
      return c.json({
        error: "insufficient_allowance",
        free_credits_exhausted: true,
        allowance_usd: err.allowance_usd,
        required_usd: err.required_usd,
        approve_again_url: "https://susurration.xyz/approve?amount=100",
      }, 402);
    }
    const msg = String(err?.message ?? err);
    if (msg === "signal_not_found") return c.json({ error: "signal_not_found" }, 404);
    if (msg === "not_a_member") return c.json({ error: "signal_not_in_caller_channel" }, 403);
    return c.json({ error: "reject_failed", detail: msg.slice(0, 200) }, 500);
  }

  const reactionEvent = {
    kind: "reaction" as const,
    reaction_id: txResult.reaction_id,
    signal_id,
    channel_id: txResult.channel_id,
    from_address: me,
    from_username: txResult.from_username,
    payload: reactionPayload,
    is_auto,
    created_at: txResult.created_at.toISOString(),
  };
  publishChannel(txResult.channel_id, reactionEvent);
  deliverToChannelMembers(txResult.channel_id, me, reactionEvent);

  recordEvent({ type: "reaction_push", address: me, channelId: txResult.channel_id, payload: { is_auto, source: "reject" } });
  void sql`UPDATE identities SET last_active_at = now() WHERE address = ${me}`.catch(() => {});

  const allowance_after = await buildAllowanceResponse(me);
  return c.json({
    ok: true,
    reaction_id: txResult.reaction_id,
    cost_usd: txResult.cost_usd,
    allowance_after,
  }, 201);
});

// ── /positions/open ─────────────────────────────────────────────────────
// Direct open without going through accept. Used by paper sync / replay
// and by agents that already issued the reaction separately. Prefer
// /signals/:id/accept for new flows.
positionsRoutes.post("/positions/open", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`positions-open:${me}`, SYNC_LIMIT);
  } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const v = await validateOpenFields(c, body, me);
  if (!("ok" in v)) return v;

  const { position_id, opened_at, existing } = await upsertPosition(me, v.fields);
  return c.json({
    ok: true,
    idempotent: existing,
    position_id,
    opened_at: opened_at.toISOString(),
    mode: v.fields.mode,
  });
});

// ── /positions/:position_id/close ───────────────────────────────────────
// Preferred close endpoint for agents that know the position_id (e.g. after
// fetching open positions and matching a broker fill). Idempotent on
// closed_at IS NULL.
positionsRoutes.post("/positions/:position_id/close", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`positions-close:${me}`, SYNC_LIMIT);
  } catch (e) { return authError(c, e); }

  const position_id = c.req.param("position_id");
  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const exit_reason = String(body?.exit_reason ?? "");
  const exit_price = Number(body?.exit_price);
  const exit_pnl_pct = Number(body?.exit_pnl_pct);
  const exit_pnl_usd = body?.exit_pnl_usd != null ? Number(body.exit_pnl_usd) : null;
  const closed_at = body?.closed_at ? String(body.closed_at) : null;
  const broker_close_id = body?.broker_close_id != null
    ? String(body.broker_close_id).slice(0, 64) : null;

  const VALID_REASONS = ["TP", "SL", "TIME", "TRAIL", "MANUAL", "stop_loss", "take_profit", "time_stop", "trailing_stop", "broker_fill"];
  if (!VALID_REASONS.includes(exit_reason)) {
    return c.json({ error: `exit_reason must be one of ${VALID_REASONS.join(", ")}` }, 400);
  }
  if (!Number.isFinite(exit_price) || !Number.isFinite(exit_pnl_pct)) {
    return c.json({ error: "exit_price and exit_pnl_pct must be finite numbers" }, 400);
  }

  const rows = await sql<{ position_id: string; mode: Mode }[]>`
    UPDATE positions
    SET closed_at = ${closed_at ? sql`${closed_at}::timestamptz` : sql`now()`},
        exit_reason = ${exit_reason},
        exit_price = ${exit_price},
        exit_pnl_pct = ${exit_pnl_pct},
        exit_pnl_usd = ${exit_pnl_usd}
    WHERE position_id = ${position_id}
      AND address = ${me}
      AND closed_at IS NULL
    RETURNING position_id, mode
  `;
  // broker_close_id, if provided, is stored in exit_reason context. We don't
  // have a dedicated column to avoid schema churn this round; the value
  // round-trips in the audit log via daemon stdout / decision log. Phase
  // 18.3 can add a column if dashboard wants to render it.
  void broker_close_id;

  if (!rows[0]) return c.json({ ok: true, idempotent: true });
  return c.json({ ok: true, position_id: rows[0].position_id, mode: rows[0].mode });
});

// ── /positions/close ────────────────────────────────────────────────────
// Legacy close-by-signal_id path. PaperTrader + PaperCloseQueue key on
// signal_id, so this is the path they hit. Kept for back-compat; new agents
// should prefer /positions/:position_id/close.
positionsRoutes.post("/positions/close", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
    rateCheck(`positions-close-sig:${me}`, SYNC_LIMIT);
  } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const signal_id = String(body?.signal_id ?? "");
  const exit_reason = String(body?.exit_reason ?? "");
  const exit_price = Number(body?.exit_price);
  const exit_pnl_pct = Number(body?.exit_pnl_pct);
  const exit_pnl_usd = body?.exit_pnl_usd != null ? Number(body.exit_pnl_usd) : null;
  const closed_at = body?.closed_at ? String(body.closed_at) : null;

  const VALID_REASONS = ["TP", "SL", "TIME", "TRAIL", "MANUAL", "stop_loss", "take_profit", "time_stop", "trailing_stop", "broker_fill"];
  if (!signal_id) return c.json({ error: "signal_id required" }, 400);
  if (!VALID_REASONS.includes(exit_reason)) {
    return c.json({ error: `exit_reason must be one of ${VALID_REASONS.join(", ")}` }, 400);
  }
  if (!Number.isFinite(exit_price) || !Number.isFinite(exit_pnl_pct)) {
    return c.json({ error: "exit_price and exit_pnl_pct must be finite numbers" }, 400);
  }

  const rows = await sql<{ position_id: string }[]>`
    UPDATE positions
    SET closed_at = ${closed_at ? sql`${closed_at}::timestamptz` : sql`now()`},
        exit_reason = ${exit_reason},
        exit_price = ${exit_price},
        exit_pnl_pct = ${exit_pnl_pct},
        exit_pnl_usd = ${exit_pnl_usd}
    WHERE address = ${me} AND signal_id = ${signal_id} AND closed_at IS NULL
    RETURNING position_id
  `;
  if (!rows[0]) return c.json({ ok: true, idempotent: true });
  return c.json({ ok: true, position_id: rows[0].position_id });
});

// ── GET /positions/mine ─────────────────────────────────────────────────
// Optional filters: status=open|closed|all (default all), mode=paper|live|all
// (default all), limit (default 200, max 500).
positionsRoutes.get("/positions/mine", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const status = c.req.query("status") ?? "all";
  const modeFilter = c.req.query("mode") ?? "all";
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);

  // Use one parameterized query with optional clauses to keep SQL injection
  // surface minimal and avoid combinatorial branches.
  const modeCond = (modeFilter === "paper" || modeFilter === "live")
    ? sql`AND mode = ${modeFilter}` : sql``;

  let rows;
  if (status === "open") {
    rows = await sql`
      SELECT * FROM positions
      WHERE address = ${me} AND closed_at IS NULL
        ${modeCond}
      ORDER BY opened_at DESC LIMIT ${limit}
    `;
  } else if (status === "closed") {
    rows = await sql`
      SELECT * FROM positions
      WHERE address = ${me} AND closed_at IS NOT NULL
        ${modeCond}
      ORDER BY closed_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT * FROM positions
      WHERE address = ${me}
        ${modeCond}
      ORDER BY opened_at DESC LIMIT ${limit}
    `;
  }
  return c.json({ positions: rows });
});
