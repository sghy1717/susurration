// Phase 17 — Peer stats endpoints for the redesigned web dashboard.
//
// /peers/stats         → all peers I've seen signal traffic with, aggregated
//                        over N days (default 30). Powers the "Top peers" rail
//                        on the Overview page and the friends list meta.
// /peers/:address/stats → same shape but for a single peer + recent signals.
//                        Powers the Friends detail panel.
//
// Both endpoints are caller-perspective: a peer's "realized PnL" here means
// "PnL on positions I opened that were sourced from that peer's signal",
// not the peer's own PnL on their own book.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";

export const peerRoutes = new Hono();

const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;
const RECENT_SIGNALS_LIMIT = 20;

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

function clampDays(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(n)));
}

// Shared aggregation. When `onlyAddress` is set, returns one row for that peer.
async function aggregatePeerStats(me: string, days: number, onlyAddress: string | null) {
  // We compute per-peer:
  //   - signal_count        : signals from this peer into channels I'm a member of
  //   - avg_conv            : AVG(payload->>'confidence')::float over those signals
  //   - top_assets          : top 2 token values by frequency in those signals
  //   - my_reactions        : count of MY reactions on signals from this peer
  //   - opens / closes      : my positions where peer_username matched
  //   - wins / losses
  //   - realized_pnl_usd    : sum of exit_pnl_usd for closed positions
  //
  // Note on accept_rate: my_reactions / signal_count. Cap at 1 in case of duplicates.

  const rows = await sql<{
    address: string;
    username: string | null;
    signal_count: number;
    avg_conv: number | null;
    top_assets: string[] | null;
    accepted_signals: number;
    opens: number;
    closes: number;
    wins: number;
    losses: number;
    realized_pnl_usd: number;
    last_signal_at: string | null;
  }[]>`
    WITH window_start AS (
      SELECT (now() - (${days} || ' days')::interval) AS t
    ),
    my_channels AS (
      SELECT channel_id FROM channel_members WHERE address = ${me}
    ),
    peer_signals AS (
      SELECT
        s.from_address                                                              AS address,
        s.signal_id,
        s.created_at,
        NULLIF((s.payload->>'confidence'), '')::double precision                    AS confidence,
        COALESCE(s.payload->>'token', s.payload->>'asset', s.payload->>'symbol')    AS token
      FROM signals s
      WHERE s.channel_id IN (SELECT channel_id FROM my_channels)
        AND s.from_address != ${me}
        AND s.created_at  >= (SELECT t FROM window_start)
        ${onlyAddress ? sql`AND s.from_address = ${onlyAddress}` : sql``}
    ),
    peer_identity AS (
      SELECT address, MAX(username) AS username
      FROM identities
      WHERE address IN (SELECT DISTINCT address FROM peer_signals)
      GROUP BY address
    ),
    sig_agg AS (
      SELECT
        address,
        COUNT(*)::int                                          AS signal_count,
        AVG(confidence)::double precision                      AS avg_conv,
        MAX(created_at)::text                                  AS last_signal_at
      FROM peer_signals
      GROUP BY address
    ),
    asset_agg AS (
      SELECT
        address,
        ARRAY(
          SELECT token FROM (
            SELECT token, COUNT(*) AS c
            FROM peer_signals ps2
            WHERE ps2.address = ps_outer.address AND ps2.token IS NOT NULL
            GROUP BY token
            ORDER BY c DESC
            LIMIT 2
          ) t
        ) AS top_assets
      FROM (SELECT DISTINCT address FROM peer_signals) ps_outer
    ),
    react_agg AS (
      -- "Signals I accepted from this peer" = signals where I left at least
      -- one reaction. reactions has no UNIQUE(signal_id, from_address) so we
      -- must use COUNT(DISTINCT) to avoid double-counting (G review #1, #5).
      -- Phase 18.2-w fix: peer_signals author column is renamed to address
      -- in the upstream CTE, so s.address (not s.from_address) is correct.
      SELECT
        s.address                               AS address,
        COUNT(DISTINCT r.signal_id)::int        AS accepted_signals
      FROM peer_signals s
      JOIN reactions r ON r.signal_id = s.signal_id AND r.from_address = ${me}
      GROUP BY s.address
    ),
    pos_agg AS (
      -- We match peer by username (peer_username column on positions).
      -- A peer who never had a username at signal time will not match — those
      -- are edge cases we accept rather than build address→username history.
      SELECT
        i.address,
        COUNT(*)::int                                                                       AS opens,
        COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL)::int                                AS closes,
        COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL AND p.exit_pnl_usd > 0)::int         AS wins,
        COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL AND p.exit_pnl_usd < 0)::int         AS losses,
        COALESCE(SUM(p.exit_pnl_usd) FILTER (WHERE p.closed_at IS NOT NULL), 0)::double precision AS realized_pnl_usd
      FROM positions p
      JOIN identities i ON i.username = p.peer_username
      WHERE p.address  = ${me}
        AND p.opened_at >= (SELECT t FROM window_start)
        AND i.address IN (SELECT DISTINCT address FROM peer_signals)
      GROUP BY i.address
    )
    SELECT
      sa.address,
      pi.username,
      sa.signal_count,
      sa.avg_conv,
      aa.top_assets,
      COALESCE(ra.accepted_signals, 0)            AS accepted_signals,
      COALESCE(pa.opens, 0)                       AS opens,
      COALESCE(pa.closes, 0)                      AS closes,
      COALESCE(pa.wins, 0)                        AS wins,
      COALESCE(pa.losses, 0)                      AS losses,
      COALESCE(pa.realized_pnl_usd, 0)::double precision AS realized_pnl_usd,
      sa.last_signal_at
    FROM sig_agg sa
    LEFT JOIN peer_identity pi ON pi.address = sa.address
    LEFT JOIN asset_agg     aa ON aa.address = sa.address
    LEFT JOIN react_agg     ra ON ra.address = sa.address
    LEFT JOIN pos_agg       pa ON pa.address = sa.address
    ORDER BY pa.realized_pnl_usd DESC NULLS LAST, sa.signal_count DESC
  `;

  return rows.map(r => ({
    address: r.address,
    username: r.username,
    signal_count: r.signal_count,
    avg_conv: r.avg_conv,
    top_assets: r.top_assets ?? [],
    // accept_rate = signals I accepted / signals from this peer.
    // DISTINCT in the SQL ensures numerator never exceeds denominator, so no
    // cap needed (G review #5).
    accepted_signals: r.accepted_signals,
    accept_rate: r.signal_count > 0 ? r.accepted_signals / r.signal_count : null,
    realized_pnl_usd: r.realized_pnl_usd,
    win_rate: r.closes > 0 ? r.wins / r.closes : null,
    opens: r.opens,
    closes: r.closes,
    wins: r.wins,
    losses: r.losses,
    last_signal_at: r.last_signal_at,
  }));
}

peerRoutes.get("/peers/stats", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const days = clampDays(c.req.query("days"));
  const peers = await aggregatePeerStats(me, days, null);

  return c.json({ days, peers });
});

peerRoutes.get("/peers/:address/stats", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const address = c.req.param("address");
  if (!address || address.length < 4 || address.length > 80) {
    return c.json({ error: "invalid_address" }, 400);
  }
  const days = clampDays(c.req.query("days"));

  const peers = await aggregatePeerStats(me, days, address);
  const stats = peers[0] ?? null;

  // Recent signals from this peer (visible to caller — only signals in
  // channels caller is a member of, which is the same scope as the
  // aggregation above). LATERAL subquery picks at most 1 reaction per signal
  // so duplicate reactions never multiply the rowcount (G review #2).
  const recent = await sql<{
    signal_id: string;
    channel_id: string;
    channel_name: string | null;
    payload: any;
    created_at: string;
    my_reaction_value: number | null;
  }[]>`
    SELECT
      s.signal_id::text,
      s.channel_id::text,
      c.name                                          AS channel_name,
      s.payload,
      s.created_at::text,
      NULLIF((latest_react.payload->>'value'), '')::int AS my_reaction_value
    FROM signals s
    JOIN channel_members cm ON cm.channel_id = s.channel_id AND cm.address = ${me}
    LEFT JOIN channels c   ON c.channel_id   = s.channel_id
    LEFT JOIN LATERAL (
      SELECT payload
      FROM reactions
      WHERE signal_id = s.signal_id AND from_address = ${me}
      ORDER BY created_at DESC
      LIMIT 1
    ) latest_react ON true
    WHERE s.from_address = ${address}
      AND s.created_at  >= (now() - (${days} || ' days')::interval)
    ORDER BY s.created_at DESC
    LIMIT ${RECENT_SIGNALS_LIMIT}
  `;

  return c.json({
    days,
    address,
    stats,
    recent_signals: recent,
  });
});
