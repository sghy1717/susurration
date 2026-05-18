// GS PRO scanner — runs in-process on the Fly.io backend.
//
// Every 60s: fetch Binance Futures public data → detect FR flip (>0→<0)
// + OI 4-segment monotonic rising ≥ 8% → push LONG signal to all @demo
// friend channels. No API key required (all public endpoints).
//
// @demo identity is auto-provisioned on startup from DEMO_KEYPAIR_SECRET.

import bs58 from "bs58";
import { sql } from "../db.ts";
import { publishChannel } from "../routes/signals.ts";
import { deliverToChannelMembers } from "./webhook.ts";
import { stripControlCharsDeep } from "../../../shared/strip-control.ts";

// ── Config ──────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 60_000;
const MIN_OI_CHANGE_PCT = 8;
const DEDUP_HOURS = 24;
const SOURCE_ID = "GS-pro-scanner-v2";
// 2026-05-18 Haze decision — emit GS pro strategy-recommended sizing as
// part of the signal so receiver agents have an absolute number to take
// (per agent_runner.buildPrompt: "pricing fields taken from the signal
// payload"). Mirror local scanner_paper.py — 100k reference book, 30%
// per-signal position. Receivers are free to ignore (Susurration thesis:
// signal source suggests; receiver decides) but at least the suggestion
// exists in the payload instead of agents defaulting to $100 paper bets.
const REF_INITIAL_BALANCE_USD = 100_000;
const REF_POSITION_PCT = 30;
const REF_POSITION_USD = REF_INITIAL_BALANCE_USD * REF_POSITION_PCT / 100;  // $30k

// ── State (in-process, resets on deploy — acceptable for dedup) ─────────
let prevFrSnapshot: Record<string, number> = {};
const alertHistory: Record<string, number> = {};  // symbol → timestamp
let demoAddress: string | null = null;

// ── Startup: ensure @demo identity ──────────────────────────────────────
async function ensureDemoAccount(): Promise<string | null> {
  const secret = process.env.DEMO_KEYPAIR_SECRET;
  if (!secret) {
    console.log("[demo-scanner] DEMO_KEYPAIR_SECRET not set, scanner disabled");
    return null;
  }

  let secretKey: Uint8Array;
  try {
    secretKey = bs58.decode(secret);
  } catch {
    console.error("[demo-scanner] invalid DEMO_KEYPAIR_SECRET (not valid base58)");
    return null;
  }
  if (secretKey.length !== 64) {
    console.error("[demo-scanner] DEMO_KEYPAIR_SECRET must be 64 bytes (ed25519 secret key)");
    return null;
  }
  const publicKey = secretKey.slice(32);
  const address = bs58.encode(publicKey);

  await sql`
    INSERT INTO identities(address, username, auto_accept_friends, free_credits_usd)
    VALUES (${address}, 'demo', true, 999999)
    ON CONFLICT (address) DO UPDATE SET
      username = COALESCE(identities.username, 'demo'),
      auto_accept_friends = true
  `;

  // Reserve the username if not already taken by this address
  const existing = await sql<{ address: string }[]>`
    SELECT address FROM identities WHERE username = 'demo'
  `;
  if (existing[0] && existing[0].address !== address) {
    console.error(`[demo-scanner] username 'demo' already taken by ${existing[0].address.slice(0, 8)}…`);
    return null;
  }

  console.log(`[demo-scanner] @demo ready (${address.slice(0, 8)}…)`);
  return address;
}

// ── Binance API helpers ─────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await resp.json() as T;
  } catch (e) {
    console.warn(`[demo-scanner] fetch failed: ${url} — ${(e as Error).message}`);
    return null;
  }
}

type BinanceTicker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };
type BinancePremiumIndex = { symbol: string; lastFundingRate: string };
type BinanceOIHist = { sumOpenInterestValue: string };
type BinanceExchangeSymbol = { symbol: string; baseAsset: string; contractType: string; quoteAsset: string; status: string };

// Stablecoin-base perps (USDCUSDT, FDUSDUSDT, etc.) are tradable on Binance
// but their "FR flips + OI piles up" signal is structurally meaningless:
// the pair pins to ~1.00 and any FR sign is a thin-orderbook artifact, not
// a directional setup. Excluding them up front keeps the demo signal stream
// honest. List captures every USD-pegged base ever listed as a Binance perp;
// safe to be inclusive because a non-stable base is never going to collide.
const STABLECOIN_BASES = new Set([
  "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "FRAX",
  "USDP", "USDD", "PYUSD", "USDE", "USTC", "EURI",
]);

interface ScanSignal {
  symbol: string;
  direction: "long" | "short";
  price: number;
  priceChg24h: number;
  volume: number;
  oiChangePct: number;
  oi4SegRising: boolean;
  currentFr: number;
  prevFr: number;
}

// ── Scanner core ────────────────────────────────────────────────────────
async function scan(): Promise<ScanSignal[]> {
  const info = await fetchJson<{ symbols: BinanceExchangeSymbol[] }>("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!info) return [];
  const symbols = info.symbols
    .filter(s =>
      s.contractType === "PERPETUAL" &&
      s.quoteAsset === "USDT" &&
      s.status === "TRADING" &&
      !STABLECOIN_BASES.has(s.baseAsset)
    )
    .map(s => s.symbol);

  const tickers = await fetchJson<BinanceTicker[]>("https://fapi.binance.com/fapi/v1/ticker/24hr");
  if (!tickers) return [];
  const tickerMap: Record<string, BinanceTicker> = {};
  for (const t of tickers) tickerMap[t.symbol] = t;

  const frAll = await fetchJson<BinancePremiumIndex[]>("https://fapi.binance.com/fapi/v1/premiumIndex");
  const frCurrent: Record<string, number> = {};
  if (frAll) for (const x of frAll) frCurrent[x.symbol] = parseFloat(x.lastFundingRate);

  const prevSnap = prevFrSnapshot;
  prevFrSnapshot = { ...frCurrent };

  if (Object.keys(prevSnap).length === 0) {
    console.log(`[demo-scanner] first run, FR snapshot saved (${Object.keys(frCurrent).length} symbols)`);
    return [];
  }

  // Bidirectional FR flip detection (mirror of local GS-pro scanner_paper.py):
  //   prev > 0, curr < 0 → LONG candidate (shorts piled, squeeze)
  //   prev < 0, curr > 0 → SHORT candidate (longs piled, squeeze)
  const justFlipped: Array<[string, "long" | "short"]> = [];
  for (const sym of symbols) {
    const prev = prevSnap[sym];
    const curr = frCurrent[sym];
    if (prev === undefined || curr === undefined) continue;
    if (prev > 0 && curr < 0) justFlipped.push([sym, "long"]);
    else if (prev < 0 && curr > 0) justFlipped.push([sym, "short"]);
  }

  if (justFlipped.length === 0) return [];
  console.log(`[demo-scanner] FR flipped: ${justFlipped.map(([s, d]) => `${s}(${d})`).join(", ")}`);

  const signals: ScanSignal[] = [];
  for (const [sym, sigDir] of justFlipped) {
    // Dedup
    // Dedup by (symbol, direction) — matches scanner_paper.py behavior.
    // LONG-then-SHORT (or vice versa) within 24h represents real structural
    // reversal and should NOT be dedup'd as same alert.
    const dedupKey = `${sym}:${sigDir}`;
    const lastAlert = alertHistory[dedupKey];
    if (lastAlert && Date.now() - lastAlert < DEDUP_HOURS * 3600_000) continue;

    const oiHist = await fetchJson<BinanceOIHist[]>(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=48`
    );
    if (!oiHist || oiHist.length < 12) continue;

    const vals = oiHist.map(x => parseFloat(x.sumOpenInterestValue));
    const segLen = Math.floor(vals.length / 4);
    if (segLen < 3) continue;

    const segs = [
      vals.slice(0, segLen).reduce((a, b) => a + b, 0) / segLen,
      vals.slice(segLen, segLen * 2).reduce((a, b) => a + b, 0) / segLen,
      vals.slice(segLen * 2, segLen * 3).reduce((a, b) => a + b, 0) / segLen,
      vals.slice(segLen * 3).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - segLen * 3),
    ];

    const oiChg = segs[0] > 0 ? ((segs[3] - segs[0]) / segs[0]) * 100 : 0;
    const segRising = segs[0] < segs[1] && segs[1] < segs[2] && segs[2] < segs[3];

    if (oiChg < MIN_OI_CHANGE_PCT || !segRising) continue;

    const t = tickerMap[sym] ?? {};
    signals.push({
      symbol: sym,
      direction: sigDir,
      price: parseFloat(t.lastPrice ?? "0"),
      priceChg24h: parseFloat(t.priceChangePercent ?? "0"),
      volume: parseFloat(t.quoteVolume ?? "0"),
      oiChangePct: oiChg,
      oi4SegRising: segRising,
      currentFr: frCurrent[sym] ?? 0,
      prevFr: prevSnap[sym] ?? 0,
    });
    alertHistory[dedupKey] = Date.now();
  }

  return signals;
}

// ── Signal push ─────────────────────────────────────────────────────────
function buildPayload(sig: ScanSignal) {
  const prevFrS = sig.prevFr.toExponential(2);
  const curFrS = sig.currentFr.toExponential(2);
  const oiScore = Math.min(Math.max((sig.oiChangePct - 8) / 25, 0), 1);
  const confidence = Math.round(Math.min(Math.max(0.4 + 0.3 * oiScore, 0.4), 0.9) * 100) / 100;

  const isShort = sig.direction === "short";
  // Mirror local scanner_paper.py SL/TP convention (8% SL / 15% TP, 2026-05-17 P26):
  //   LONG  : SL below entry (entry*0.92),  TP above entry (entry*1.15)
  //   SHORT : SL above entry (entry*1.08),  TP below entry (entry*0.85)
  const sl = isShort ? sig.price * 1.08 : sig.price * 0.92;
  const tp = isShort ? sig.price * 0.85 : sig.price * 1.15;
  return {
    direction: sig.direction,
    token: sig.symbol,
    confidence,
    horizon: "swing",
    reason: `FR flip ${prevFrS} -> ${curFrS}, OI +${sig.oiChangePct.toFixed(1)}% (4-seg rising), 24h ${sig.priceChg24h.toFixed(1)}%, vol $${(sig.volume / 1e6).toFixed(1)}M`,
    source_id: SOURCE_ID,
    metadata: {
      entry_price: sig.price,
      stop_loss: Math.round(sl * 1e8) / 1e8,
      take_profit: Math.round(tp * 1e8) / 1e8,
      leverage: 3,
      // 2026-05-18 Haze decision — see REF_POSITION_USD constant above.
      // GS pro suggests its strategy-typical sizing for a 100k account so
      // receivers can size paper trades meaningfully out of the box.
      position_pct: REF_POSITION_PCT,
      position_usd: REF_POSITION_USD,
      time_stop_hours: 48,
      raw_signal: {
        oi_change_pct: Math.round(sig.oiChangePct * 100) / 100,
        prev_fr_8h: sig.prevFr,
        current_fr_8h: sig.currentFr,
        price_chg_24h: sig.priceChg24h,
        volume_24h_m: Math.round(sig.volume / 1e6 * 100) / 100,
        oi_4seg_rising: sig.oi4SegRising,
      },
    },
  };
}

async function pushToAllDemoChannels(payload: unknown) {
  if (!demoAddress) return;
  const sanitized = stripControlCharsDeep(payload);

  // Find all channels where @demo is a member
  const channels = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM channel_members WHERE address = ${demoAddress}
  `;
  if (channels.length === 0) {
    console.log("[demo-scanner] no friend channels yet, skipping push");
    return;
  }

  for (const { channel_id } of channels) {
    try {
      // 2026-05-18 G review P1 #6 — wrap signal INSERT + usage_log in a
      // transaction so they share atomicity with the user-driven path in
      // `signals.ts:422+`. cost=0 makes it benign today, but keeping the
      // two paths symmetric removes a footgun if demo ever moves to a
      // non-zero meter and a crash between the two INSERTs leaves a
      // signal without its usage row.
      const row = await sql.begin(async (tx) => {
        const insert = await tx<{ signal_id: string; created_at: Date }[]>`
          INSERT INTO signals(channel_id, from_address, payload)
          VALUES (${channel_id}, ${demoAddress}, ${sql.json(sanitized as any)})
          RETURNING signal_id, created_at
        `;
        const r = insert[0]!;
        await tx`
          INSERT INTO usage_log(address, channel_id, signal_id, call_type, cost_usd)
          VALUES (${demoAddress}, ${channel_id}, ${r.signal_id}, 'signal_push', 0)
        `;
        return r;
      });

      const wireEvent = {
        kind: "signal" as const,
        signal_id: row.signal_id,
        channel_id,
        from_address: demoAddress,
        from_username: "demo",
        payload: sanitized,
        created_at: row.created_at.toISOString(),
      };
      publishChannel(channel_id, wireEvent);
      deliverToChannelMembers(channel_id, demoAddress, wireEvent);
    } catch (e) {
      console.warn(`[demo-scanner] push to channel ${channel_id.slice(0, 8)} failed: ${(e as Error).message}`);
    }
  }
  console.log(`[demo-scanner] pushed to ${channels.length} channel(s)`);
}

// ── Main loop ───────────────────────────────────────────────────────────
async function tick() {
  try {
    const signals = await scan();
    if (signals.length === 0) return;
    console.log(`[demo-scanner] ${signals.length} signal(s): ${signals.map(s => s.symbol).join(", ")}`);
    for (const sig of signals) {
      const payload = buildPayload(sig);
      await pushToAllDemoChannels(payload);
    }
  } catch (e) {
    console.error(`[demo-scanner] tick error: ${(e as Error).message}`);
  }
}

export async function startDemoScanner() {
  demoAddress = await ensureDemoAccount();
  if (!demoAddress) return;

  // Run first tick immediately (populates FR snapshot), then every 60s
  await tick();
  setInterval(tick, SCAN_INTERVAL_MS);
  console.log(`[demo-scanner] started (interval=${SCAN_INTERVAL_MS / 1000}s)`);
}
