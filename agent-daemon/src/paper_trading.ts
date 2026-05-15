// Built-in paper trading — the sandbox that ships with every daemon.
//
// Purpose: zero-risk environment for users to verify their agent
// collaboration pipeline end-to-end before connecting real APIs.
// Signal comes in → daemon evaluates → react +1 → paper trade opens →
// position tracked → auto-closes on SL/TP/trailing/time stop.
//
// In-process, zero spawn overhead. Replaces the old on_decision hook
// pattern where every decision launched a full Node runtime.
//
// Writes to ~/.susu/paper_trades.json.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { syncPaperOpen, syncPaperClose, fetchPaperPositionsMine, type SusuClientConfig } from "./susu_actions.ts";
import { dirname } from "node:path";

// ── Default strategy constants ──────────────────────────────────────────
const DEFAULT_LEVERAGE = 3;
const DEFAULT_POSITION_PCT = 30;   // % of balance per trade
const DEFAULT_SL_PCT = 0.08;       // 8% below entry
const DEFAULT_TP_PCT = 0.12;       // 12% above entry
const DEFAULT_TIME_STOP_HOURS = 48;
const DEFAULT_TRAILING_ACTIVATE = 15; // activate trailing at 15% leveraged PnL
const DEFAULT_TRAILING_GIVEBACK = 50; // close when 50% of peak PnL lost
const DEFAULT_INITIAL_BALANCE = 100;
const TRACK_INTERVAL_MS = 60_000;  // check positions every 60s

// ── Types ───────────────────────────────────────────────────────────────

export interface PaperTrade {
  id: string;
  token: string;
  direction: string;
  leverage: number;
  position_pct: number;
  position_usd: number;
  notional_usd: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  time_stop_hours: number;
  trailing_activate_pct: number;
  trailing_giveback_pct: number;
  best_pnl_pct: number;
  size_factor: number;
  peer: string;
  signal_id: string;
  opened_at: string;
  exit_price: number | null;
  exit_time: string | null;
  exit_reason: string | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  status: "open" | "closed";
}

export interface PaperBook {
  initial_balance: number;
  trades: PaperTrade[];
}

// ── Price fetching (Binance Futures) ────────────────────────────────────

async function fetchPrices(symbols: Set<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.size === 0) return out;
  try {
    const resp = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as { symbol: string; price: string }[];
    for (const d of data) {
      if (symbols.has(d.symbol)) out.set(d.symbol, parseFloat(d.price));
    }
  } catch (err) {
    process.stderr.write(`[paper] price fetch error: ${(err as Error)?.message ?? err}\n`);
  }
  return out;
}

// ── PaperTrader ─────────────────────────────────────────────────────────

export class PaperTrader {
  private trackTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private tradesPath: string,
    private minSizeFactor: number = 0.5,
    private maxOpen: number = Infinity,
    private eventLogPath?: string,
    /** Phase 11a — when set, paper opens/closes mirror to server (cross-device).
     *  When null, daemon stays local-only (offline / opt-out). */
    private susuClient?: SusuClientConfig | null,
  ) {
    mkdirSync(dirname(tradesPath), { recursive: true });
  }

  /** Phase 11a — On startup, pull server-side open positions and merge into
   *  local book. Useful after daemon reinstall / new device — server is
   *  cross-device source of truth for visibility. Local PaperTrade.id stays
   *  as daemon's sequential counter; signal_id is the dedup key.
   *
   *  Fire-and-forget: failures don't block daemon startup. */
  async syncFromServerOnce(): Promise<void> {
    if (!this.susuClient) return;
    try {
      const remote = await fetchPaperPositionsMine(this.susuClient, "open");
      if (!remote.positions || remote.positions.length === 0) return;
      const book = this.loadBook();
      const localSignalIds = new Set(book.trades.map((t) => t.signal_id));
      let added = 0;
      for (const r of remote.positions) {
        if (!r.signal_id || localSignalIds.has(r.signal_id)) continue;
        // Reconstruct local PaperTrade from server row.
        const id = String(book.trades.length + 1 + added).padStart(3, "0");
        book.trades.push({
          id,
          token: r.token,
          direction: r.direction,
          leverage: r.leverage,
          position_pct: 0,  // not persisted server-side; safe default
          position_usd: r.position_usd,
          notional_usd: r.position_usd * r.leverage,
          entry_price: r.entry_price,
          stop_loss: r.stop_loss,
          take_profit: r.take_profit,
          time_stop_hours: DEFAULT_TIME_STOP_HOURS,
          trailing_activate_pct: DEFAULT_TRAILING_ACTIVATE,
          trailing_giveback_pct: DEFAULT_TRAILING_GIVEBACK,
          best_pnl_pct: 0,
          size_factor: r.size_factor ?? 0.7,
          peer: r.peer_username ? `@${r.peer_username}` : "@?",
          signal_id: r.signal_id,
          opened_at: r.opened_at ?? new Date().toISOString(),
          exit_price: null,
          exit_time: null,
          exit_reason: null,
          pnl_pct: null,
          pnl_usd: null,
          status: "open",
        });
        added++;
      }
      if (added > 0) {
        this.saveBook(book);
        process.stderr.write(`[paper] synced ${added} open position(s) from server\n`);
      }
    } catch (err) {
      process.stderr.write(`[paper] server sync failed (non-fatal): ${(err as Error)?.message ?? err}\n`);
    }
  }

  private emitEvent(evt: Record<string, unknown>): void {
    if (!this.eventLogPath) return;
    try {
      appendFileSync(this.eventLogPath, JSON.stringify(evt) + "\n", "utf8");
    } catch { /* best effort */ }
  }

  /** Start the position tracking loop. Call once from daemon main(). */
  startTracking(): void {
    // Immediate first check, then periodic.
    this.trackPositions();
    this.trackTimer = setInterval(() => this.trackPositions(), TRACK_INTERVAL_MS);
  }

  /** Stop the tracking loop (for graceful shutdown). */
  stopTracking(): void {
    if (this.trackTimer) {
      clearInterval(this.trackTimer);
      this.trackTimer = null;
    }
  }

  /** Called after every daemon decision. Opens on react +1 above threshold.
   *  @param origSignalPayload — when trigger is a reaction, the normalized
   *    payload of the original signal (has token, entry_price, etc.). */
  onDecision(decision: any, trigger: any, origSignalPayload?: Record<string, unknown>): void {
    if (decision?.kind !== "react") return;
    const p = decision.payload ?? {};
    if (p.value !== "+1") return;
    // Default sf=0.7 when LLM omits size_factor (schema says required but
    // some models still skip it). 0.7 = "moderate conviction" — ensures
    // a +1 always opens a position rather than silently dropping.
    const sf = typeof p.size_factor === "number" ? p.size_factor : 0.7;

    // Use original signal payload when trigger is a reaction.
    const sigPayload = origSignalPayload ?? trigger?.payload ?? {};

    // Only open positions for trade_entry signals (or signals with no type field).
    // Prevents opening on trade_exit, smoke_test, relay_path_fix, etc.
    const sigType = sigPayload.type as string | undefined;
    if (sigType && sigType !== "trade_entry") {
      const peer: string = trigger?.from_username ?? "?";
      process.stderr.write(`[paper] skip react +1 from ${peer}: signal type="${sigType}" (only trade_entry opens positions)\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: `signal type="${sigType}" not trade_entry`, token: (sigPayload.token as string) ?? "?", peer });
      return;
    }

    const token: string | undefined = sigPayload.token as string | undefined;

    if (sf < this.minSizeFactor) {
      const peer: string = trigger?.from_username ?? "?";
      process.stderr.write(`[paper] skip react +1 ${token ?? "?"} from ${peer}: size_factor ${sf} < min ${this.minSizeFactor}\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: `size_factor ${sf} < min ${this.minSizeFactor}`, token: token ?? "?", peer, sf });
      return;
    }
    const direction: string = sigPayload.direction ?? "long";
    if (direction !== "long" && direction !== "short") {
      const peer: string = trigger?.from_username ?? "?";
      process.stderr.write(`[paper] skip react +1 ${token ?? "?"} from ${peer}: direction="${direction}" (must be long or short)\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: `direction="${direction}" not supported`, token: token ?? "?", peer });
      return;
    }

    const peer: string = trigger?.from_username ?? "?";
    if (!token) {
      process.stderr.write(`[paper] skip react +1 from ${peer}: missing token in signal payload\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: "missing token in signal payload", token: "?", peer });
      return;
    }

    const book = this.loadBook();

    if (book.trades.some((t) => t.token === token && t.status === "open")) {
      process.stderr.write(`[paper] skip react +1 ${token} from ${peer}: already open\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: "already open", token, peer });
      return;
    }
    const openCount = book.trades.filter((t) => t.status === "open").length;
    if (openCount >= this.maxOpen) {
      process.stderr.write(`[paper] skip react +1 ${token} from ${peer}: max open positions (${this.maxOpen})\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: `max open positions (${this.maxOpen})`, token, peer });
      return;
    }

    const meta = sigPayload.metadata ?? {};
    const leverage = meta.leverage ?? DEFAULT_LEVERAGE;
    const entryPrice = meta.entry_price;
    if (!entryPrice || typeof entryPrice !== "number" || entryPrice <= 0) {
      process.stderr.write(`[paper] skip react +1 ${token} from ${peer}: no valid entry_price in metadata\n`);
      this.emitEvent({ kind: "paper_skip", ts: new Date().toISOString(), reason: "no valid entry_price in metadata", token, peer });
      return;
    }

    const isShort = direction === "short";
    const slPct = meta.stop_loss
      ? Math.abs(meta.stop_loss - entryPrice) / entryPrice
      : DEFAULT_SL_PCT;
    const tpPct = meta.take_profit
      ? Math.abs(meta.take_profit - entryPrice) / entryPrice
      : DEFAULT_TP_PCT;

    const balance = this.getBalance(book);
    const posPct = (meta.position_pct ?? DEFAULT_POSITION_PCT) * sf;
    const posUsd = balance * posPct / 100;

    const id = String(book.trades.length + 1).padStart(3, "0");
    const trade: PaperTrade = {
      id,
      token,
      direction,
      leverage,
      position_pct: Math.round(posPct * 100) / 100,
      position_usd: Math.round(posUsd * 10000) / 10000,
      notional_usd: Math.round(posUsd * leverage * 10000) / 10000,
      entry_price: entryPrice,
      stop_loss: meta.stop_loss ?? Math.round(entryPrice * (isShort ? 1 + slPct : 1 - slPct) * 100000000) / 100000000,
      take_profit: meta.take_profit ?? Math.round(entryPrice * (isShort ? 1 - tpPct : 1 + tpPct) * 100000000) / 100000000,
      time_stop_hours: meta.time_stop_hours ?? DEFAULT_TIME_STOP_HOURS,
      trailing_activate_pct: DEFAULT_TRAILING_ACTIVATE,
      trailing_giveback_pct: DEFAULT_TRAILING_GIVEBACK,
      best_pnl_pct: 0,
      size_factor: sf,
      peer: peer.startsWith("@") ? peer : `@${peer}`,
      signal_id: decision.signal_id ?? "",
      opened_at: new Date().toISOString(),
      exit_price: null,
      exit_time: null,
      exit_reason: null,
      pnl_pct: null,
      pnl_usd: null,
      status: "open",
    };
    book.trades.push(trade);
    this.saveBook(book);
    process.stderr.write(
      `[paper] OPEN #${id} ${token} ${direction} ${leverage}x sf=${sf} ` +
      `entry=${entryPrice} SL=${trade.stop_loss} TP=${trade.take_profit} ` +
      `pos=$${posUsd.toFixed(2)} bal=$${balance.toFixed(2)} from ${trade.peer}\n`,
    );
    this.emitEvent({
      kind: "paper_open",
      ts: trade.opened_at,
      id: trade.id, token, direction, leverage,
      entry_price: entryPrice,
      stop_loss: trade.stop_loss,
      take_profit: trade.take_profit,
      position_usd: trade.position_usd,
      size_factor: sf,
      peer: trade.peer,
      balance,
    });
    // Phase 11a — mirror to server for cross-device visibility.
    if (this.susuClient && trade.signal_id) {
      const channelId = (trigger as any)?.channel_id ?? "";
      const isReplay = !!(sigPayload as any)?.replay;
      syncPaperOpen(this.susuClient, {
        signal_id: trade.signal_id,
        channel_id: channelId,
        token, direction, leverage,
        entry_price: entryPrice,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        position_usd: trade.position_usd,
        size_factor: sf,
        peer_username: peer.replace(/^@/, ""),
        is_replay: isReplay,
        opened_at: trade.opened_at,
        daemon_local_id: trade.id,
      });
    }
  }

  /** One-shot position check. Use in --once poll mode after processing events. */
  async checkOnce(): Promise<void> {
    return this.trackPositions();
  }

  /** Check all open positions against current prices. Close on SL/TP/trailing/time. */
  private async trackPositions(): Promise<void> {
    const book = this.loadBook();
    const openTrades = book.trades.filter((t) => t.status === "open");
    if (openTrades.length === 0) return;

    const symbols = new Set(openTrades.map((t) => t.token));
    const prices = await fetchPrices(symbols);
    let dirty = false;

    for (const t of openTrades) {
      const price = prices.get(t.token);
      if (price == null) continue;

      const isShort = t.direction === "short";
      const pnlPct = (isShort
        ? ((t.entry_price - price) / t.entry_price)
        : ((price - t.entry_price) / t.entry_price)) * 100 * t.leverage;

      // Track best PnL for trailing stop.
      if (pnlPct > t.best_pnl_pct) {
        t.best_pnl_pct = Math.round(pnlPct * 100) / 100;
        dirty = true;
      }

      let reason: string | null = null;
      if (isShort ? price >= t.stop_loss : price <= t.stop_loss) {
        reason = "stop_loss";
      } else if (isShort ? price <= t.take_profit : price >= t.take_profit) {
        reason = "take_profit";
      } else if (
        t.best_pnl_pct >= t.trailing_activate_pct &&
        pnlPct <= t.best_pnl_pct * (1 - t.trailing_giveback_pct / 100)
      ) {
        reason = "trailing_stop";
      } else {
        // Time stop.
        const ageH = (Date.now() - new Date(t.opened_at).getTime()) / 3_600_000;
        if (ageH >= t.time_stop_hours) {
          reason = "time_stop";
        }
      }

      if (reason) {
        const pnlUsd = Math.round((pnlPct / 100) * t.position_usd * 10000) / 10000;
        t.exit_price = price;
        t.exit_time = new Date().toISOString();
        t.exit_reason = reason;
        t.pnl_pct = Math.round(pnlPct * 100) / 100;
        t.pnl_usd = pnlUsd;
        t.status = "closed";
        dirty = true;
        process.stderr.write(
          `[paper] CLOSE #${t.id} ${t.token} ${reason} ` +
          `exit=${price} pnl=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ` +
          `($${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}) ` +
          `best=${t.best_pnl_pct >= 0 ? "+" : ""}${t.best_pnl_pct.toFixed(2)}%\n`,
        );
        this.emitEvent({
          kind: "paper_close",
          ts: t.exit_time,
          id: t.id, token: t.token,
          entry_price: t.entry_price,
          exit_price: price,
          exit_reason: reason,
          pnl_pct: t.pnl_pct,
          pnl_usd: pnlUsd,
          best_pnl_pct: t.best_pnl_pct,
          peer: t.peer,
        });
        // Phase 11a — mirror close to server.
        if (this.susuClient && t.signal_id) {
          syncPaperClose(this.susuClient, {
            signal_id: t.signal_id,
            exit_reason: reason,
            exit_price: price,
            exit_pnl_pct: t.pnl_pct,
            exit_pnl_usd: pnlUsd,
            closed_at: t.exit_time ?? new Date().toISOString(),
          });
        }
      }
    }

    if (dirty) this.saveBook(book);
  }

  private getBalance(book: PaperBook): number {
    let bal = book.initial_balance;
    for (const t of book.trades) {
      if (t.status === "closed" && t.pnl_usd != null) bal += t.pnl_usd;
    }
    return Math.round(bal * 10000) / 10000;
  }

  private loadBook(): PaperBook {
    try {
      return JSON.parse(readFileSync(this.tradesPath, "utf8"));
    } catch {
      return { initial_balance: DEFAULT_INITIAL_BALANCE, trades: [] };
    }
  }

  private saveBook(book: PaperBook): void {
    writeFileSync(this.tradesPath, JSON.stringify(book, null, 2));
  }
}
