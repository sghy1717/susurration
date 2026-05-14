// Server-side position close detection. Runs every 30s, queries all open
// positions (signals with +1 reactions not yet in position_closes), fetches
// current prices from Binance Futures, checks TP/SL/TIME/TRAIL conditions,
// and persists closes. Replaces the unreliable frontend-only detection that
// depended on the user having the dashboard open.

import { sql } from "../db.ts";

const CLOSE_INTERVAL_MS = 30_000;
const TIME_STOP_MS = 48 * 60 * 60 * 1000;
const TRAILING_STOP_THRESHOLD = 5;
const TRAILING_STOP_RETRACE = 0.5;

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
    take_profit: takeProfit ?? entryPrice * (isShort ? 0.88 : 1.12),
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

async function tick() {
  try {
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
      if (newPeak > TRAILING_STOP_THRESHOLD && pnlPct < newPeak * TRAILING_STOP_RETRACE) {
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
