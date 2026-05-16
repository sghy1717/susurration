// Phase 17 — Book endpoints for the redesigned web dashboard.
//
// /book/snapshot  → all hero KPIs in one round-trip (balance components, win
//                   rate, signal counts, position counts). Frontend computes
//                   current_balance = initial + realized + unrealized (it
//                   has live mark prices via /prices).
// /book/equity    → daily cumulative realized PnL series for the equity
//                   sparkline. Returns N days of points (default 21).
//
// Both endpoints are caller-only: you can only see your own book.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";

export const bookRoutes = new Hono();

const INITIAL_BALANCE_USD = 100_000; // paper trading default; matches daemon
const MAX_EQUITY_DAYS = 90;

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

bookRoutes.get("/book/snapshot", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  // Phase 18.2 — optional mode filter. Default = both books combined (the
  // pre-18.2 behaviour, so old dashboards still render). `?mode=paper` or
  // `?mode=live` narrows the KPI to one book; dashboards that want both
  // separately fan out two requests.
  const modeQ = c.req.query("mode");
  const modeFilter = (modeQ === "paper" || modeQ === "live") ? modeQ : null;
  const modeCond = modeFilter ? sql`AND mode = ${modeFilter}` : sql``;

  // 1. Positions aggregate (open/closed, wins/losses, realized PnL).
  //    These queries always return exactly one row (no GROUP BY), but TS sees
  //    them as `Row[]`, so we use `!` after asserting via the SQL contract.
  const posRows = await sql<{
    open_count: number;
    closed_count: number;
    wins: number;
    losses: number;
    break_even: number;
    realized_pnl_total: number;
  }[]>`
    SELECT
      COUNT(*) FILTER (WHERE closed_at IS NULL)::int                                                  AS open_count,
      COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::int                                              AS closed_count,
      COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND exit_pnl_usd > 0)::int                         AS wins,
      COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND exit_pnl_usd < 0)::int                         AS losses,
      COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND exit_pnl_usd = 0)::int                         AS break_even,
      COALESCE(SUM(exit_pnl_usd) FILTER (WHERE closed_at IS NOT NULL), 0)::double precision           AS realized_pnl_total
    FROM positions
    WHERE address = ${me}
      ${modeCond}
  `;
  const posAgg = posRows[0]!;

  // 2. Signals received from peers (peers push into channels I'm in, not me).
  //    Uses 30d window — 24h counts derived in same query via FILTER.
  const sigRows = await sql<{ signals_received_24h: number; signals_received_30d: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE s.created_at >= now() - interval '24 hours')::int AS signals_received_24h,
      COUNT(*)::int                                                            AS signals_received_30d
    FROM signals s
    JOIN channel_members cm ON cm.channel_id = s.channel_id
    WHERE cm.address      = ${me}
      AND s.from_address != ${me}
      AND s.created_at   >= now() - interval '30 days'
  `;
  const sigAgg = sigRows[0]!;

  // 3. Signals I accepted (= signals I reacted to at least once).
  //    `reactions` has no UNIQUE(signal_id, from_address) so a caller can
  //    react N times to one signal. For "accept rate" the meaningful unit
  //    is "did I react at all?" → COUNT(DISTINCT signal_id).
  //    G review #1, #5 — replaces naive COUNT(*) which let accept_rate > 1.
  const reactRows = await sql<{ accepted_24h: number; accepted_30d: number }[]>`
    SELECT
      COUNT(DISTINCT signal_id) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS accepted_24h,
      COUNT(DISTINCT signal_id)::int                                                          AS accepted_30d
    FROM reactions
    WHERE from_address = ${me}
      AND created_at  >= now() - interval '30 days'
  `;
  const reactAgg = reactRows[0]!;

  const win_rate = posAgg.closed_count > 0 ? posAgg.wins / posAgg.closed_count : null;
  const accept_rate_24h = sigAgg.signals_received_24h > 0 ? reactAgg.accepted_24h / sigAgg.signals_received_24h : null;
  const accept_rate_30d = sigAgg.signals_received_30d > 0 ? reactAgg.accepted_30d / sigAgg.signals_received_30d : null;

  return c.json({
    initial_balance_usd: INITIAL_BALANCE_USD,
    mode: modeFilter ?? "all",
    realized_pnl_total: posAgg.realized_pnl_total,
    open_count: posAgg.open_count,
    closed_count: posAgg.closed_count,
    wins: posAgg.wins,
    losses: posAgg.losses,
    break_even: posAgg.break_even,
    win_rate,
    signals_received_24h: sigAgg.signals_received_24h,
    signals_received_30d: sigAgg.signals_received_30d,
    accepted_24h: reactAgg.accepted_24h,
    accepted_30d: reactAgg.accepted_30d,
    accept_rate_24h,
    accept_rate_30d,
    // Phase 18.2 (G review #8) — accept_rate uses the reactions table, which
    // doesn't carry a mode column. So accept_rate is constant across mode
    // filters by construction; the dashboard should show it once, not twice.
    accept_rate_scope: "all_modes",
  });
});

bookRoutes.get("/book/equity", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const daysRaw = Number(c.req.query("days") ?? 21);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(MAX_EQUITY_DAYS, Math.floor(daysRaw))) : 21;

  // Phase 18.2 — optional mode filter so the dashboard can show paper / live
  // as two distinct equity curves on the same chart. No filter = combined.
  const modeQ = c.req.query("mode");
  const modeFilter = (modeQ === "paper" || modeQ === "live") ? modeQ : null;
  const modeCond = modeFilter ? sql`AND mode = ${modeFilter}` : sql``;

  // Build a date series (today and N-1 days back) and LEFT JOIN daily realized
  // PnL. Window function gives cumulative; we also add a baseline equal to all
  // realized PnL realized BEFORE the window so the chart starts from "true
  // historical balance up to (today - N + 1)" not from zero.
  const rows = await sql<{ day: string; realized_cumulative_usd: number }[]>`
    WITH series AS (
      SELECT (date_trunc('day', now()) - (gs.n * interval '1 day'))::date AS day
      FROM generate_series(0, ${days - 1}) AS gs(n)
    ),
    baseline AS (
      SELECT COALESCE(SUM(exit_pnl_usd), 0)::double precision AS prior_total
      FROM positions
      WHERE address = ${me}
        AND closed_at IS NOT NULL
        AND date_trunc('day', closed_at AT TIME ZONE 'UTC') < (SELECT MIN(day) FROM series)
        ${modeCond}
    ),
    daily AS (
      SELECT
        date_trunc('day', closed_at AT TIME ZONE 'UTC')::date AS day,
        COALESCE(SUM(exit_pnl_usd), 0)::double precision      AS pnl
      FROM positions
      WHERE address = ${me}
        AND closed_at IS NOT NULL
        AND closed_at >= (SELECT MIN(day) FROM series)
        ${modeCond}
      GROUP BY 1
    )
    SELECT
      s.day::text AS day,
      ((SELECT prior_total FROM baseline) +
       COALESCE(SUM(d.pnl) OVER (ORDER BY s.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0))::double precision
        AS realized_cumulative_usd
    FROM series s
    LEFT JOIN daily d ON d.day = s.day
    ORDER BY s.day ASC
  `;

  return c.json({
    initial_balance_usd: INITIAL_BALANCE_USD,
    mode: modeFilter ?? "all",
    days,
    points: rows,
  });
});
