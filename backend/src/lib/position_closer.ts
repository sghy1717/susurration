// Server-side position close detection. Runs every 30s, queries all open
// positions (signals with +1 reactions not yet in position_closes), fetches
// current prices from Binance Futures, checks TP/SL/TIME/TRAIL conditions,
// and persists closes. Replaces the unreliable frontend-only detection that
// depended on the user having the dashboard open.

import { sql } from "../db.ts";

const CLOSE_INTERVAL_MS = 30_000;
const TIME_STOP_MS = 48 * 60 * 60 * 1000;
// 2026-05-17 P26 同步 GS pro: trailing 激活 15% (杠杆后) / continuous lock gap 5%
//   trigger = max(0, peak - LOCK_GAP). 老逻辑 giveback 50% 已废弃.
const TRAILING_ACTIVATE_PCT = 15;
const TRAILING_LOCK_GAP_PCT = 5;

const peakPnlMap = new Map<string, number>();

interface OpenPosition {
  address: string;
  signal_id: string;
  token: string;
  direction: "long" | "short";
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  opened_at: Date;
}

function parsePosition(row: any): OpenPosition | null {
  const p = row.payload;
  if (!p || typeof p !== "object" || p.truncated) return null;
  const meta = p.metadata ?? {};
  const token = p.token ?? p.symbol ?? p.ticker ?? p.pair ?? meta.token;
  const direction = (p.direction ?? p.side ?? p.dir ?? meta.direction ?? "long").toLowerCase();
  const entryPrice = meta.entry_price ?? p.entry_price ?? p.entry ?? p.price;
  const leverage = meta.leverage ?? p.leverage ?? p.lev ?? 3;
  const stopLoss = meta.stop_loss ?? p.stop_loss ?? p.sl;
  const takeProfit = meta.take_profit ?? p.take_profit ?? p.tp;
  if (!token || !entryPrice || typeof entryPrice !== "number" || entryPrice <= 0) return null;
  if (direction !== "long" && direction !== "short") return null;
  const sigType = p.type as string | undefined;
  if (sigType && sigType !== "trade_entry") return null;

  const isShort = direction === "short";
  return {
    address: row.address,
    signal_id: row.signal_id,
    token,
    direction,
    leverage,
    entry_price: entryPrice,
    stop_loss: stopLoss ?? entryPrice * (isShort ? 1.08 : 0.92),
    take_profit: takeProfit ?? entryPrice * (isShort ? 0.85 : 1.15),  // 2026-05-17 P26: TP 12 → 15
    opened_at: new Date(row.created_at),
  };
}

async function fetchPrices(): Promise<Record<string, number>> {
  try {
    const resp = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
      signal: AbortSignal.timeout(8_000),
    });
    const tickers = (await resp.json()) as { symbol: string; price: string }[];
    const map: Record<string, number> = {};
    for (const t of tickers) map[t.symbol] = parseFloat(t.price);
    return map;
  } catch {
    return {};
  }
}

// G review P0 #2 (2026-05-18) — Phase 18.2 introduced `/signals/:id/accept`
// which writes positions directly to the `positions` table (not the legacy
// reactions + position_closes pair). The original tick() query explicitly
// `NOT EXISTS positions` to avoid double-closing daemon-tracked rows —
// which means if the daemon is offline, new-path positions accumulate
// forever (silent data rot: dashboard shows "open" forever).
//
// Fix: run a SECOND fallback pass on the `positions` table specifically
// for rows whose owner's daemon hasn't pinged for ≥ 10 minutes
// (almost certainly offline). The daemon-online path is unchanged; this
// only kicks in when the daemon can't.
const DAEMON_STALE_MS = 10 * 60 * 1000;

async function tickNewPositionsFallback() {
  const staleCutoff = new Date(Date.now() - DAEMON_STALE_MS);
  const rows = await sql<{
    position_id: string;
    address: string;
    signal_id: string;
    token: string;
    direction: "long" | "short";
    leverage: number;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    position_usd: number;
    opened_at: Date;
  }[]>`
    SELECT p.position_id::text AS position_id, p.address,
           p.signal_id::text AS signal_id,
           p.token, p.direction, p.leverage,
           p.entry_price, p.stop_loss, p.take_profit, p.position_usd,
           p.opened_at
    FROM positions p
    JOIN identities i ON i.address = p.address
    WHERE p.mode = 'paper'
      AND p.closed_at IS NULL
      AND (i.last_daemon_ping_at IS NULL OR i.last_daemon_ping_at < ${staleCutoff})
  `;
  if (rows.length === 0) return;
  const prices = await fetchPrices();
  if (Object.keys(prices).length === 0) return;

  type Close = {
    position_id: string;
    address: string;
    signal_id: string;
    exit_reason: string;
    exit_price: number;
    exit_pnl_pct: number;
    exit_pnl_usd: number;
  };
  const closes: Close[] = [];
  for (const pos of rows) {
    const cp = prices[pos.token];
    if (cp === undefined) continue;
    const isShort = pos.direction === "short";
    const pnlPct = isShort
      ? ((pos.entry_price - cp) / pos.entry_price) * 100 * pos.leverage
      : ((cp - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;
    const key = `${pos.signal_id}:${pos.address}`;
    const ageMs = Date.now() - new Date(pos.opened_at).getTime();

    const pushClose = (exit_reason: string, exit_price: number, exit_pnl_pct: number) => {
      peakPnlMap.delete(key);
      closes.push({
        position_id: pos.position_id, address: pos.address, signal_id: pos.signal_id,
        exit_reason, exit_price, exit_pnl_pct,
        exit_pnl_usd: (exit_pnl_pct / 100) * pos.position_usd,
      });
    };

    if (ageMs > TIME_STOP_MS) { pushClose("TIME", cp, pnlPct); continue; }
    if (isShort ? cp >= pos.stop_loss : cp <= pos.stop_loss) {
      const exitPnl = isShort
        ? ((pos.entry_price - pos.stop_loss) / pos.entry_price) * 100 * pos.leverage
        : ((pos.stop_loss - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;
      pushClose("SL", pos.stop_loss, exitPnl); continue;
    }
    if (isShort ? cp <= pos.take_profit : cp >= pos.take_profit) {
      const exitPnl = isShort
        ? ((pos.entry_price - pos.take_profit) / pos.entry_price) * 100 * pos.leverage
        : ((pos.take_profit - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;
      pushClose("TP", pos.take_profit, exitPnl); continue;
    }
    const prevPeak = peakPnlMap.get(key) ?? 0;
    const newPeak = Math.max(prevPeak, pnlPct);
    peakPnlMap.set(key, newPeak);
    const trailingTrigger = newPeak - TRAILING_LOCK_GAP_PCT;
    if (newPeak >= TRAILING_ACTIVATE_PCT && trailingTrigger > 0 && pnlPct < trailingTrigger) {
      pushClose("TRAIL", cp, pnlPct);
    }
  }
  for (const c of closes) {
    // Idempotent on closed_at IS NULL — racing daemon won't double-close.
    await sql`
      UPDATE positions
      SET closed_at = now(),
          exit_reason = ${c.exit_reason},
          exit_price = ${c.exit_price},
          exit_pnl_pct = ${c.exit_pnl_pct},
          exit_pnl_usd = ${c.exit_pnl_usd}
      WHERE position_id = ${c.position_id}::uuid
        AND closed_at IS NULL
    `;
  }
  if (closes.length > 0) {
    console.log(
      `[position-closer/fallback] closed ${closes.length} stale-daemon paper rows: ` +
      closes.map(c => `${c.signal_id.slice(0, 8)} ${c.exit_reason}`).join(", "),
    );
  }
}

async function tick() {
  try {
    await tickNewPositionsFallback();
    // Phase 17.5 — daemon-driven close is the primary path (writes positions
    // with full open+close context). Server-side close is fallback for when
    // daemon is offline / not installed. Skip rows that daemon already owns,
    // otherwise the two paths compete on the same signal_id with different exit
    // thresholds (server: hardcoded 0.92/1.08 fallback SL/TP; daemon: real config).
    const rows = await sql`
      SELECT
        r.from_address AS address,
        s.signal_id::text AS signal_id,
        s.payload,
        s.created_at
      FROM reactions r
      JOIN signals s ON s.signal_id = r.signal_id
      LEFT JOIN position_closes pc
        ON pc.signal_id = s.signal_id::text
        AND pc.address = r.from_address
      WHERE r.payload->>'value' = '+1'
        AND pc.signal_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM positions pp
          WHERE pp.signal_id = s.signal_id
            AND pp.address = r.from_address
        )
    `;

    if (rows.length === 0) return;

    const positions = rows.map(parsePosition).filter(Boolean) as OpenPosition[];
    if (positions.length === 0) return;

    const prices = await fetchPrices();
    if (Object.keys(prices).length === 0) return;

    const closes: { signal_id: string; address: string; exit_reason: string; exit_price: number; exit_pnl_pct: number }[] = [];

    for (const pos of positions) {
      const cp = prices[pos.token];
      if (cp === undefined) continue;

      const isShort = pos.direction === "short";
      const pnlPct = isShort
        ? ((pos.entry_price - cp) / pos.entry_price) * 100 * pos.leverage
        : ((cp - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;

      const key = `${pos.signal_id}:${pos.address}`;

      const ageMs = Date.now() - pos.opened_at.getTime();
      if (ageMs > TIME_STOP_MS) {
        peakPnlMap.delete(key);
        closes.push({ signal_id: pos.signal_id, address: pos.address, exit_reason: "TIME", exit_price: cp, exit_pnl_pct: pnlPct });
        continue;
      }

      const hitSl = isShort ? cp >= pos.stop_loss : cp <= pos.stop_loss;
      if (hitSl) {
        peakPnlMap.delete(key);
        const exitPnl = isShort
          ? ((pos.entry_price - pos.stop_loss) / pos.entry_price) * 100 * pos.leverage
          : ((pos.stop_loss - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;
        closes.push({ signal_id: pos.signal_id, address: pos.address, exit_reason: "SL", exit_price: pos.stop_loss, exit_pnl_pct: exitPnl });
        continue;
      }

      const hitTp = isShort ? cp <= pos.take_profit : cp >= pos.take_profit;
      if (hitTp) {
        peakPnlMap.delete(key);
        const exitPnl = isShort
          ? ((pos.entry_price - pos.take_profit) / pos.entry_price) * 100 * pos.leverage
          : ((pos.take_profit - pos.entry_price) / pos.entry_price) * 100 * pos.leverage;
        closes.push({ signal_id: pos.signal_id, address: pos.address, exit_reason: "TP", exit_price: pos.take_profit, exit_pnl_pct: exitPnl });
        continue;
      }

      const prevPeak = peakPnlMap.get(key) ?? 0;
      const newPeak = Math.max(prevPeak, pnlPct);
      peakPnlMap.set(key, newPeak);
      // P26: continuous lock gap. peak ≥ 15% 才激活, trigger = peak - 5%, 价跌破 trigger 触发 close
      const trailingTrigger = newPeak - TRAILING_LOCK_GAP_PCT;
      if (newPeak >= TRAILING_ACTIVATE_PCT && trailingTrigger > 0 && pnlPct < trailingTrigger) {
        peakPnlMap.delete(key);
        closes.push({ signal_id: pos.signal_id, address: pos.address, exit_reason: "TRAIL", exit_price: cp, exit_pnl_pct: pnlPct });
      }
    }

    for (const c of closes) {
      await sql`
        INSERT INTO position_closes (signal_id, address, exit_reason, exit_price, exit_pnl_pct)
        VALUES (${c.signal_id}, ${c.address}, ${c.exit_reason}, ${c.exit_price}, ${c.exit_pnl_pct})
        ON CONFLICT (signal_id, address) DO NOTHING
      `;
    }

    if (closes.length > 0) {
      console.log(`[position-closer] closed ${closes.length}: ${closes.map(c => `${c.signal_id.slice(0, 8)} ${c.exit_reason}`).join(", ")}`);
    }
  } catch (e) {
    console.error(`[position-closer] tick error: ${(e as Error).message}`);
  }
}

export async function startPositionCloser() {
  await tick();
  setInterval(tick, CLOSE_INTERVAL_MS);
  console.log(`[position-closer] started (interval=${CLOSE_INTERVAL_MS / 1000}s)`);
}
