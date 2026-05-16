import React, { useState, useCallback, useRef, useEffect, createContext, useContext } from "react";
import { useLang, LangToggle } from "./i18n.tsx";
import { AGENT_DOC } from "../../shared/agent-doc.ts";
import bs58 from "bs58";

const API = "/api";

type WalletProvider = {
  connect: () => Promise<{ publicKey: { toBase58: () => string; toBytes: () => Uint8Array } }>;
  signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
  disconnect?: () => Promise<void>;
};

function getWalletProvider(id: string): WalletProvider | null {
  const w = window as any;
  if (id === "phantom") return w.phantom?.solana ?? w.solana ?? null;
  if (id === "okx") return w.okxwallet?.solana ?? null;
  return null;
}

async function walletAuth(provider: WalletProvider): Promise<{ token: string; address: string; expires_at: string }> {
  const resp = await provider.connect();
  const address = resp.publicKey.toBase58();

  const nonceRes = await fetch(`${API}/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!nonceRes.ok) throw new Error((await nonceRes.json()).error ?? "nonce failed");
  const { nonce, message } = await nonceRes.json();

  const encoded = new TextEncoder().encode(message);
  const { signature } = await provider.signMessage(encoded);
  const signature_b58 = bs58.encode(signature);

  const verifyRes = await fetch(`${API}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, nonce, signature_b58 }),
  });
  if (!verifyRes.ok) throw new Error((await verifyRes.json()).error ?? "verify failed");
  return verifyRes.json();
}

const MARK_S = (
  <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
    <path d="M281 -9Q222 -9 177.5 10.0Q133 29 107.5 62.5Q82 96 78 142H186Q190 115 215.0 98.5Q240 82 281 82H324Q373 82 398.0 102.0Q423 122 423 155Q423 187 400.5 205.5Q378 224 334 230L263 241Q175 255 133.5 291.5Q92 328 92 400Q92 476 141.5 517.5Q191 559 288 559H326Q412 559 463.5 519.5Q515 480 522 414H414Q410 438 387.5 453.0Q365 468 326 468H288Q241 468 219.5 450.5Q198 433 198 399Q198 369 217.0 354.0Q236 339 276 333L349 321Q442 308 485.5 269.5Q529 231 529 158Q529 79 477.5 35.0Q426 -9 324 -9Z" fill="#a5b4c7" transform="translate(9.40 24.00) scale(0.02200 -0.02200)"/>
  </svg>
);

const TAKEN_HANDLES = ["susurration", "admin", "test"];

type AgentId = "claude" | "cursor" | "copilot" | "windsurf" | "codex" | "cline" | "other";

// ── Auth context — shared across all dashboard pages ──
interface AuthCtx {
  token: string | null;
  username: string | null;
  address: string | null;
}
const AuthContext = createContext<AuthCtx>({ token: null, username: null, address: null });
function useAuth() { return useContext(AuthContext); }

type Page = "dashboard" | "feed" | "friends" | "mode" | "settings";
const NavContext = createContext<(p: Page) => void>(() => {});
const ActivityBadgeContext = createContext<{ setHasNew: (v: boolean) => void }>({ setHasNew: () => {} });
function useNav() { return useContext(NavContext); }

async function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const token = localStorage.getItem("susu_token");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts?.headers as Record<string, string> ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function timeAgo(iso: string, lang: "en" | "zh" = "en"): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (lang === "zh") {
    if (m < 1) return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return d === 1 ? "昨天" : `${d} 天前`;
  }
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}-${md} ${hm}`;
}

function mcpJson(token: string) {
  return `{
  "mcpServers": {
    "susurration": {
      "command": "npx",
      "args": ["-y", "@susurration/mcp"],
      "env": {
        "SUSU_TOKEN": "${token}"
      }
    }
  }
}`;
}

function maskToken(token: string) {
  if (token.length <= 12) return token;
  return token.slice(0, 8) + "••••••••••••";
}

const AGENTS: { id: AgentId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "cursor", name: "Cursor" },
  { id: "copilot", name: "GitHub Copilot" },
  { id: "windsurf", name: "Windsurf" },
  { id: "codex", name: "Codex" },
  { id: "cline", name: "Cline" },
  { id: "other", name: "Other" },
];

interface Friend {
  friend_address: string;
  friend_username: string | null;
  channel_id: string;
  created_at: string;
}
interface FriendRequest {
  request_id: string;
  from_addr: string;
  from_username: string | null;
  created_at: string;
}
interface Group {
  channel_id: string;
  name: string | null;
  owner: string;
  created_at: string;
  member_count: number;
}
interface GroupMember {
  address: string;
  username: string | null;
  joined_at: string;
}
interface FeedItem {
  kind: string;
  signal_id: string | null;
  reaction_id: string | null;
  parent_signal_id?: string | null;
  channel_id: string;
  from_address: string;
  from_username: string | null;
  payload: any;
  created_at: string;
  channel_name: string | null;
  /** Phase 10 G #5 fix — explicit is_group from channels.is_group instead of
   *  the heuristic !!channel_name (which couples to "groups always have a name"). */
  is_group?: boolean;
  peer?: { address: string; username: string | null };
  is_auto?: boolean;
}

// ── PnL types & helpers ────────────────────────────────────────────────

interface Position {
  token: string;
  direction: "long" | "short";
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  peer: string;
  signalId: string;
  openedAt: string;
  currentPrice?: number;
  pnlPct?: number;
  pnlUsd?: number;
  status: "open" | "closed";
  exitReason?: string;
  exitPrice?: number;
  positionUsd: number;
  /** v4 — replay signal opened a dry-run position. Visually separated and
   *  excluded from totalPnl / totalCapital aggregates. */
  isReplay?: boolean;
  /** Phase 17.5 — row was inserted by historical backfill script (pre-Phase-11a
   *  daemons didn't sync to paper_positions, so entry context was reconstructed
   *  by JOIN with signals.payload). position_usd is 0 (unrecoverable) and
   *  leverage may be a fallback default. Dashboard renders these with an
   *  "*历史推断*" / "*inferred*" tag and excludes from totals. */
  isBackfilled?: boolean;
}

function normalizeSignalPayload(p: any): {
  token?: string; direction?: string; entryPrice?: number;
  leverage?: number; stopLoss?: number; takeProfit?: number;
} | null {
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
  return { token, direction, entryPrice, leverage, stopLoss, takeProfit };
}

function buildPositions(feed: FeedItem[], myAddress: string): Position[] {
  const signalMap = new Map<string, FeedItem>();
  for (const f of feed) {
    if (f.kind === "signal" && f.signal_id) signalMap.set(f.signal_id, f);
  }

  const positions: Position[] = [];
  const seenSignals = new Set<string>();

  for (const f of feed) {
    if (f.kind !== "reaction") continue;
    if (f.from_address !== myAddress) continue;
    const rv = f.payload?.value;
    if (rv !== "+1") continue;
    const parentId = f.parent_signal_id;
    if (!parentId || seenSignals.has(parentId)) continue;
    seenSignals.add(parentId);

    const sig = signalMap.get(parentId);
    if (!sig) continue;

    const norm = normalizeSignalPayload(sig.payload);
    if (!norm) continue;

    const isShort = norm.direction === "short";
    const sl = norm.stopLoss ?? norm.entryPrice! * (isShort ? 1.08 : 0.92);
    const tp = norm.takeProfit ?? norm.entryPrice! * (isShort ? 0.88 : 1.12);
    // Phase 14 G #3 — was hardcoded `1000 * 0.3 * sizeFactor` baseline, which
    // showed wrong USD figures for users on old daemons (server paper_positions
    // empty → fallback to feed-derived → fake $ values misled users about real
    // PnL). positionUsd=0 here signals "not synced from server"; UI must check
    // and display "% only / $ pending sync" instead of fake dollar amount.
    // After daemon v0.0.15 user upgrade + sync, server positions take over and
    // include real position_usd from the daemon's own balance computation.

    positions.push({
      token: norm.token!,
      direction: norm.direction as "long" | "short",
      leverage: norm.leverage!,
      entryPrice: norm.entryPrice!,
      stopLoss: sl,
      takeProfit: tp,
      peer: sig.from_username ? `@${sig.from_username}` : sig.from_address.slice(0, 8),
      signalId: parentId,
      openedAt: sig.created_at,
      status: "open",
      positionUsd: 0,  // 0 = not synced, UI shows "$ pending sync"
      isReplay: sig.payload?.replay === true,
    });
  }
  return positions;
}

const TIME_STOP_MS = 48 * 60 * 60 * 1000; // 48h
const TRAILING_STOP_THRESHOLD = 5; // activate after 5% profit
const TRAILING_STOP_RETRACE = 0.5; // close when retraced 50% from peak
const peakPnlMap = new Map<string, number>();

interface CloseRecord { exit_reason: string; exit_price: number; exit_pnl_pct: number }

function applyPrices(
  positions: Position[],
  prices: Record<string, number>,
  persistedCloses: Map<string, CloseRecord>,
): { positions: Position[] } {
  const result = positions.map(pos => {
    // Phase 17.5 bug fix — server-truth respect: a position that already
    // came back from the server with status="closed" must NOT be reclassified
    // by the client's SL/TP/Time evaluator. Earlier code's fallthrough at
    // the bottom of this function unconditionally set status="open", which
    // turned every closed backfilled position into an "open" one whenever
    // the time-stop window happened to be < 48h (because opened_at on
    // backfilled rows was off — separate bug). Either way: closed-from-
    // server stays closed, full stop. Only enrich with current price for
    // display.
    if (pos.status === "closed") {
      return { ...pos, currentPrice: prices[pos.token] };
    }

    const stored = persistedCloses.get(pos.signalId);
    if (stored) {
      const cp = prices[pos.token];
      return { ...pos, currentPrice: cp, pnlPct: stored.exit_pnl_pct, pnlUsd: (stored.exit_pnl_pct / 100) * pos.positionUsd, status: "closed" as const, exitReason: stored.exit_reason, exitPrice: stored.exit_price };
    }

    const cp = prices[pos.token];
    if (cp === undefined) return pos;

    const isShort = pos.direction === "short";
    const pnlPct = isShort
      ? ((pos.entryPrice - cp) / pos.entryPrice) * 100 * pos.leverage
      : ((cp - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage;
    const pnlUsd = (pnlPct / 100) * pos.positionUsd;

    const ageMs = Date.now() - new Date(pos.openedAt).getTime();
    if (ageMs > TIME_STOP_MS) {
      peakPnlMap.delete(pos.signalId);
      return { ...pos, currentPrice: cp, pnlPct, pnlUsd, status: "closed" as const, exitReason: "TIME", exitPrice: cp };
    }

    const hitSl = isShort ? cp >= pos.stopLoss : cp <= pos.stopLoss;
    const hitTp = isShort ? cp <= pos.takeProfit : cp >= pos.takeProfit;

    if (hitSl) {
      peakPnlMap.delete(pos.signalId);
      const exitPnl = isShort
        ? ((pos.entryPrice - pos.stopLoss) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.stopLoss - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage;
      return { ...pos, currentPrice: cp, pnlPct: exitPnl, pnlUsd: (exitPnl / 100) * pos.positionUsd, status: "closed" as const, exitReason: "SL", exitPrice: pos.stopLoss };
    }
    if (hitTp) {
      peakPnlMap.delete(pos.signalId);
      const exitPnl = isShort
        ? ((pos.entryPrice - pos.takeProfit) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.takeProfit - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage;
      return { ...pos, currentPrice: cp, pnlPct: exitPnl, pnlUsd: (exitPnl / 100) * pos.positionUsd, status: "closed" as const, exitReason: "TP", exitPrice: pos.takeProfit };
    }

    const prevPeak = peakPnlMap.get(pos.signalId) ?? 0;
    const newPeak = Math.max(prevPeak, pnlPct);
    peakPnlMap.set(pos.signalId, newPeak);
    if (newPeak > TRAILING_STOP_THRESHOLD && pnlPct < newPeak * TRAILING_STOP_RETRACE) {
      peakPnlMap.delete(pos.signalId);
      return { ...pos, currentPrice: cp, pnlPct, pnlUsd, status: "closed" as const, exitReason: "TRAIL", exitPrice: cp };
    }

    return { ...pos, currentPrice: cp, pnlPct, pnlUsd, status: "open" as const };
  });

  return { positions: result };
}

function validateHandle(v: string) {
  return v.length >= 5 && v.length <= 20 && /^[a-z0-9_-]+$/.test(v);
}

function McpJsonPre({ token }: { token: string }) {
  return (
    <pre>
      {"{\n  "}
      <span className="tok-key">"mcpServers"</span><span className="tok-punct">{": {"}</span>{"\n    "}
      <span className="tok-key">"susurration"</span><span className="tok-punct">{": {"}</span>{"\n      "}
      <span className="tok-key">"command"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"npx"</span><span className="tok-punct">,</span>{"\n      "}
      <span className="tok-key">"args"</span><span className="tok-punct">:</span>{" ["}<span className="tok-str">"-y"</span><span className="tok-punct">,</span>{" "}<span className="tok-str">"@susurration/mcp"</span><span className="tok-punct">],</span>{"\n      "}
      <span className="tok-key">"env"</span><span className="tok-punct">{": {"}</span>{"\n        "}
      <span className="tok-key">"SUSU_TOKEN"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"{maskToken(token)}"</span>{"\n      "}
      <span className="tok-punct">{"}"}</span>{"\n    "}
      <span className="tok-punct">{"}"}</span>{"\n  "}
      <span className="tok-punct">{"}"}</span>{"\n"}
      <span className="tok-punct">{"}"}</span>
    </pre>
  );
}

// ── Wallet brand SVGs ──
function PhantomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 128 128" fill="none">
      <defs><linearGradient id="ph-g" x1="16" y1="0" x2="112" y2="128"><stop stopColor="#534BB1"/><stop offset="1" stopColor="#551BF9"/></linearGradient></defs>
      <rect width="128" height="128" rx="26" fill="url(#ph-g)"/>
      <path d="M108.2 64.4c0 .6-.5 1.1-1.1 1.1h-4.3c-.5 0-1-.4-1.1-.9C100 47.7 85.7 34.4 68.4 34.4H43.7C35.7 34.4 29 40.5 28.9 48.5 28.7 65 28.6 81.3 29.3 97.7c.1 1.8 2.2 2.7 3.6 1.5 5.4-4.6 12.7-7 20.2-6.2.6.1 1 .5 1 1.1v1c0 .6-.4 1.1-1 1.1-5.8-.1-11.4 2-15.7 5.6-.7.6-.3 1.7.6 1.7h29.4c17.5 0 32.2-12.6 34.7-29.6l3.7-25.3c.3-1.8 2.9-2 3.4-.2l.5 1.6c1 3.2 1.5 6.5 1.5 9.9v5zM47.4 55.6a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm19 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" fill="#fff"/>
    </svg>
  );
}
function OkxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 128 128" fill="none">
      <rect width="128" height="128" rx="26" fill="#000"/>
      <rect x="18" y="18" width="28" height="28" rx="4" fill="#fff"/><rect x="50" y="18" width="28" height="28" rx="4" fill="#fff"/><rect x="82" y="18" width="28" height="28" rx="4" fill="#fff"/>
      <rect x="18" y="50" width="28" height="28" rx="4" fill="#fff"/><rect x="82" y="50" width="28" height="28" rx="4" fill="#fff"/>
      <rect x="18" y="82" width="28" height="28" rx="4" fill="#fff"/><rect x="50" y="82" width="28" height="28" rx="4" fill="#fff"/><rect x="82" y="82" width="28" height="28" rx="4" fill="#fff"/>
    </svg>
  );
}

// ── Copy button ──
function CopyBtn({ text, className }: { text: string; className?: string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`d-copy-btn ${copied ? "copied" : ""} ${className ?? ""}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

// ── Awaiting signal card — shown when user has friends but no signal today ──
function AwaitingSignalCard() {
  const { t } = useLang();
  return (
    <div className="awaiting-card">
      <div className="awaiting-header">
        <span className="awaiting-title">{t("dash.awaitingTitle")}</span>
      </div>
      <div className="awaiting-desc">{t("dash.awaitingDesc")}</div>
      <div className="awaiting-skeleton" aria-hidden>
        {[0, 1, 2].map(i => (
          <div className="awaiting-skel-row" key={i}>
            <span className="skel-cell skel-w-token" />
            <span className="skel-cell skel-w-dir" />
            <span className="skel-cell skel-w-price" />
            <span className="skel-cell skel-w-pnl" />
            <span className="skel-cell skel-w-reason" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Signal card (shared between dashboard + feed) ──
function SignalCard({ handle, avatar, avatarColor, time, channel, isGroup, symbol, direction, leverage, entry, sltp, reason, agrees, against, skips, compact, expired }: {
  handle: string; avatar: string; avatarColor?: string; time: string; channel: string;
  /** Phase 10 D8: true = group channel (renders ⌘ icon + accent color); false/undefined = 1-on-1 */
  isGroup?: boolean;
  symbol: string; direction: "long" | "short"; leverage: string; entry: string; sltp: string;
  reason: string; agrees: number; against: number; skips?: number; compact?: boolean; expired?: boolean;
}) {
  const { t } = useLang();
  const dirLabel = direction === "long" ? "LONG" : "SHORT";
  return (
    <div className={`signal-card${expired ? " signal-expired" : ""}${isGroup ? " signal-card-group" : ""}`}>
      <div className="signal-card-head">
        <div className="signal-avatar" style={avatarColor ? { color: avatarColor } : undefined}>{avatar}</div>
        <div className="signal-meta">
          <div className="handle">@{handle}</div>
          <div className="ts">{time}</div>
        </div>
        {expired && <div className="signal-missed-badge">{t("sig.missed")}</div>}
        <div className={`signal-channel-badge${isGroup ? " channel-badge-group" : ""}`}>
          {isGroup && <span style={{ marginRight: 4, opacity: 0.85 }}>⌘</span>}
          {channel}
        </div>
      </div>
      <div className="signal-grid">
        <div className="sig-cell"><div className="sig-cell-label">{compact ? t("sig.symbol") : t("sig.symbol")}</div><div className="sig-cell-val sig-token">[{symbol}]</div></div>
        <div className="sig-cell"><div className="sig-cell-label">{compact ? t("sig.dir") : t("sig.direction")}</div><div className={`sig-cell-val ${direction}`}>{dirLabel}</div></div>
        <div className="sig-cell"><div className="sig-cell-label">{compact ? t("sig.lev") : t("sig.leverage")}</div><div className="sig-cell-val">{leverage}</div></div>
        <div className="sig-cell"><div className="sig-cell-label">{t("sig.entry")}</div><div className="sig-cell-val">{entry}</div></div>
        <div className="sig-cell"><div className="sig-cell-label">{compact ? "SL/TP" : t("sig.sltp")}</div><div className="sig-cell-val">{sltp}</div></div>
      </div>
      {reason && <div className="signal-body-text">{reason}</div>}
      <div className="signal-card-foot">
        {expired ? (
          <span className="react-count" style={{ opacity: 0.5 }}>{t("sig.expiredNote")}</span>
        ) : (
          <span className="react-count">
            <span>{agrees}</span> {t("sig.agree")} · <span>{against}</span> {t("sig.against")}
            {skips !== undefined && <> · <span>{skips}</span> {t("sig.skip")}</>}
          </span>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   ONBOARDING
// ════════════════════════════════════════════════════════
function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { t, lang } = useLang();
  const [step, setStep] = useState(1);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [handleVal, setHandleVal] = useState("");
  const [handleStatus, setHandleStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("claude");
  const [connState, setConnState] = useState<"idle" | "testing" | "success" | "fail">("idle");
  const [showSkip, setShowSkip] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const timerRef = useRef<number>(0);

  // v4 Phase 7c — Connectivity test gate. Step 3 unlocks Enter Dashboard
  // ONLY after: server pushes test signal → daemon LLM evaluates → daemon
  // reacts +1 → web detects react in feed. If anything in this chain fails,
  // user can't proceed.
  type TestStage = "idle" | "pushing" | "waiting_react" | "success" | "fail";
  const [testStage, setTestStage] = useState<TestStage>("idle");
  const [testSignalId, setTestSignalId] = useState<string | null>(null);
  const [testFailReason, setTestFailReason] = useState<string | null>(null);
  const [testElapsedSec, setTestElapsedSec] = useState(0);
  const testStartRef = useRef<number>(0);
  const testPollRef = useRef<number>(0);
  const testTickRef = useRef<number>(0);
  // v4 Phase 9 二步确认：用户必须显式 ack「installer 跑完了 + IDE 重启了」才能
  // 点测试。Phase 7 ship 后 N=1 真用户 ef3c1f14 在 28s 内就点了测试 → 90s
  // timeout fail，因为根本没装 daemon。这个 checkbox 拦截这种"看到按钮直接点"
  // 的反模式。
  const [readyAcked, setReadyAcked] = useState(false);


  const goStep = (n: number) => {
    if (n === 3 && !handleVal && !localStorage.getItem("susu_handle")) return;
    setStep(n);
  };

  const connectWallet = async (id: string) => {
    setSelectedWallet(id);
    setWalletError(null);
    const provider = getWalletProvider(id);
    if (!provider) {
      setWalletError(id === "phantom" ? t("ob.err.phantomNotFound") : t("ob.err.okxNotFound"));
      return;
    }
    setWalletConnecting(true);
    try {
      const session = await walletAuth(provider);
      setAuthToken(session.token);
      setWalletAddress(session.address);
      localStorage.setItem("susu_token", session.token);
      localStorage.setItem("susu_address", session.address);

      const whoami = await fetch(`${API}/identity/whoami`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (whoami.ok) {
        const me = await whoami.json();
        if (me.username) {
          localStorage.setItem("susu_handle", me.username);
          setHandleVal(me.username);
          setStep(3);
          return;
        }
      }
      setStep(2);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("User rejected") || msg.includes("cancelled")) {
        setWalletError(t("ob.step1.rejected"));
      } else {
        setWalletError(msg);
      }
    } finally {
      setWalletConnecting(false);
    }
  };

  const checkHandle = (v: string) => {
    setHandleVal(v);
    clearTimeout(timerRef.current);
    if (!v) { setHandleStatus("idle"); return; }
    if (!validateHandle(v)) { setHandleStatus("invalid"); return; }
    setHandleStatus("checking");
    timerRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API}/identity/by-username/${encodeURIComponent(v)}`);
        setHandleStatus(res.status === 404 ? "available" : "taken");
      } catch {
        setHandleStatus(TAKEN_HANDLES.includes(v) ? "taken" : "available");
      }
    }, 600);
  };

  const [registerError, setRegisterError] = useState<string | null>(null);
  const registerHandle = async () => {
    if (!authToken || !handleVal || handleStatus !== "available") return;
    setRegisterError(null);
    try {
      const res = await fetch(`${API}/identity/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ username: handleVal }),
      });
      const data = await res.json();
      if (!res.ok) {
        const code = data.error ?? "";
        const i18nKey = `ob.err.${code}`;
        const translated = t(i18nKey);
        setRegisterError(translated !== i18nKey ? translated : (data.message ?? code));
        return;
      }
      localStorage.setItem("susu_handle", data.username);
      goStep(3);
    } catch (e: any) {
      setRegisterError(e?.message || t("ob.err.registerFailed"));
    }
  };

  // Cleanup test poll timers when Onboarding unmounts.
  useEffect(() => () => {
    if (testPollRef.current) window.clearInterval(testPollRef.current);
    if (testTickRef.current) window.clearInterval(testTickRef.current);
  }, []);

  const TEST_TIMEOUT_SEC = 90;
  const triggerConnectivityTest = async () => {
    if (!authToken) return;
    setTestStage("pushing");
    setTestFailReason(null);
    setTestSignalId(null);
    setTestElapsedSec(0);
    testStartRef.current = Date.now();
    fireOnboardingEvent("connectivity_test_click");

    try {
      const res = await fetch(`${API}/connectivity-test/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setTestStage("fail");
        setTestFailReason(data?.message ?? data?.error ?? "trigger failed");
        fireOnboardingEvent("connectivity_test_result", { result: "fail", context: { stage: "push", reason: data?.error } });
        return;
      }
      setTestSignalId(data.signal_id);
      setTestStage("waiting_react");

      // Tick elapsed seconds every 1s for UI countdown
      testTickRef.current = window.setInterval(() => {
        const sec = Math.floor((Date.now() - testStartRef.current) / 1000);
        setTestElapsedSec(sec);
      }, 1000);

      // Poll feed every 2s for daemon's reaction to the test signal
      testPollRef.current = window.setInterval(async () => {
        const elapsedSec = (Date.now() - testStartRef.current) / 1000;
        if (elapsedSec > TEST_TIMEOUT_SEC) {
          if (testPollRef.current) window.clearInterval(testPollRef.current);
          if (testTickRef.current) window.clearInterval(testTickRef.current);
          setTestStage("fail");
          setTestFailReason(lang === "zh"
            ? "等到 90 秒上限仍未收到 agent 反应。检查：① installer 跑完 + IDE 完全重启过 ② `claude -p` 或你配的 runner 在 shell 里能跑 ③ `claude mcp list` 里能看到 susurration。（90 秒是上限，agent 一般 5-30 秒就反应）"
            : "Hit the 90s ceiling without a reaction. Check: ① installer ran clean + IDE fully restarted ② `claude -p` (or your configured runner) works from your shell ③ susurration appears in `claude mcp list`. (90s is the cap — agents usually react in 5-30s.)");
          fireOnboardingEvent("connectivity_test_result", { result: "fail", context: { stage: "timeout", elapsed_sec: String(Math.floor(elapsedSec)) } });
          return;
        }
        try {
          const feedRes = await apiFetch<{ events: FeedItem[] }>("/signals/feed?limit=30");
          const events = feedRes.events ?? [];
          // Look for a +1 reaction by me to the test signal
          const reacted = events.some((e) =>
            e.kind === "reaction" &&
            e.parent_signal_id === data.signal_id &&
            e.payload?.value === "+1"
          );
          if (reacted) {
            if (testPollRef.current) window.clearInterval(testPollRef.current);
            if (testTickRef.current) window.clearInterval(testTickRef.current);
            setTestStage("success");
            fireOnboardingEvent("connectivity_test_result", { result: "success", context: { elapsed_sec: String(Math.floor(elapsedSec)) } });
          }
        } catch { /* swallow network blips; let timeout handle hard failures */ }
      }, 2000);
    } catch (e: any) {
      setTestStage("fail");
      setTestFailReason(e?.message ?? "network error");
      fireOnboardingEvent("connectivity_test_result", { result: "fail", context: { stage: "network" } });
    }
  };

  const fireOnboardingEvent = (action: string, extra: Record<string, unknown> = {}) => {
    const tk = localStorage.getItem("susu_token");
    fetch(`${API}/onboarding/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
      body: JSON.stringify({ action, ...extra }),
      keepalive: true,
    }).catch(() => {});
  };

  const testConnection = () => {
    setConnState("testing");
    setShowSkip(false);
    setSkipped(false);
    fireOnboardingEvent("detect_click", { agent: selectedAgent });
    const tk = localStorage.getItem("susu_token");
    if (!tk) {
      setConnState("fail"); setShowSkip(true);
      fireOnboardingEvent("detect_result", { agent: selectedAgent, result: "fail", context: { reason: "no_token" } });
      return;
    }
    fetch(`${API}/identity/whoami`, { headers: { Authorization: `Bearer ${tk}` } })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((me: any) => {
        if (me.last_mcp_ping_at) {
          const ago = Date.now() - new Date(me.last_mcp_ping_at).getTime();
          if (ago < 5 * 60 * 1000) {
            setConnState("success");
            fireOnboardingEvent("detect_result", { agent: selectedAgent, result: "success" });
            return;
          }
        }
        setConnState("fail"); setShowSkip(true);
        fireOnboardingEvent("detect_result", { agent: selectedAgent, result: "fail", context: { reason: "no_recent_ping" } });
      })
      .catch(() => {
        setConnState("fail"); setShowSkip(true);
        fireOnboardingEvent("detect_result", { agent: selectedAgent, result: "fail", context: { reason: "fetch_error" } });
      });
  };

  const connHelpKeys = (agent: AgentId): string[] => {
    const configPath: Record<AgentId, string> = {
      claude: "conn.path.claude", cursor: "conn.path.cursor", copilot: "conn.path.copilot",
      windsurf: "conn.path.windsurf", codex: "conn.path.codex", cline: "conn.path.cline", other: "conn.path.other",
    };
    return [configPath[agent], "conn.help.s1", "conn.help.s2", "conn.help.s3", "conn.help.s4", "conn.help.s5"];
  };

  return (
    <div className="onboarding-overlay">
      <div className="onboard-wrap">
        <div className="onboard-brand">
          <div className="onboard-brand-mark">{MARK_S}</div>
          <span className="onboard-brand-name">susurration</span>
          <span style={{ flex: 1 }} />
          <LangToggle />
        </div>

        <div className="step-row">
          {[1, 2, 3].map((i) => (
            <div key={i} className={`step-pip ${i === step ? "active" : i < step ? "done" : ""}`} />
          ))}
        </div>

        {/* Step 1: Connect Wallet */}
        <div className={`onboard-step ${step === 1 ? "visible" : ""}`}>
          <div className="step-label">{t("ob.step1of3")}</div>
          <div className="step-title">{t("ob.step1.title")}</div>
          <div className="step-sub">{t("ob.step1.sub")}</div>
          {([["phantom", "Phantom", <PhantomIcon key="p" />], ["okx", "OKX Wallet", <OkxIcon key="o" />]] as const).map(([id, label, icon]) => (
            <button key={id} className={`auth-btn ${selectedWallet === id ? "selected" : ""}`} disabled={walletConnecting} onClick={() => connectWallet(id)}>
              <div className="auth-btn-icon">{icon}</div>
              {walletConnecting && selectedWallet === id ? t("ob.step1.connecting") : label}
            </button>
          ))}
          {walletError && <div className="auth-error">{walletError}</div>}
          <div className="auth-note">{t("ob.step1.note")}</div>
        </div>

        {/* Step 2: Handle */}
        <div className={`onboard-step ${step === 2 ? "visible" : ""}`}>
          <div className="step-label">{t("ob.step2of3")}</div>
          <div className="step-title">{t("ob.step2.title")}</div>
          <div className="step-sub">{t("ob.step2.sub")}</div>
          <div className="handle-input-wrap">
            <span className="handle-at">@</span>
            <input className="handle-input" type="text" placeholder="your_handle" value={handleVal} onChange={(e) => checkHandle(e.target.value)} />
            <span className={`handle-check ${handleStatus === "available" ? "available" : handleStatus === "taken" || handleStatus === "invalid" ? "taken" : "checking"}`}>
              {handleStatus === "idle" ? "—" : t(`ob.handle.${handleStatus}`)}
            </span>
          </div>
          <ul className="handle-rules">
            <li>{t("ob.step2.rule1")}</li>
            <li>{t("ob.step2.rule2")}</li>
            <li>{t("ob.step2.rule3")}</li>
          </ul>
          {registerError && <div className="auth-error">{registerError}</div>}
          <div className="onboard-nav">
            <button className="ob-btn-back" onClick={() => goStep(1)}>{t("ob.back")}</button>
            <button className="ob-btn-next" disabled={handleStatus !== "available"} onClick={registerHandle}>{t("ob.continue")}</button>
          </div>
        </div>

        {/* Step 3: One-click installer (v4) */}
        <div className={`onboard-step ${step === 3 ? "visible" : ""}`}>
          <div className="step-label">{t("ob.step3of3")}</div>
          <div className="step-title">{lang === "zh" ? "连接你的 AGENT" : "Connect your AGENT"}</div>
          <div className="step-sub">{lang === "zh" ? "一行命令搞定 — installer 自动检测你所有装好的 AI IDE 并配置 Susurration。" : "One command. Installer auto-detects all your AI IDEs and wires up Susurration."}</div>

          {/* Prerequisite checklist */}
          <div className="prereq-list" style={{ background: "var(--surface-2, #1a1a1a)", border: "1px solid var(--border, #2a2a2a)", borderRadius: 6, padding: "12px 14px", marginTop: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8 }}>
              {lang === "zh" ? "开始前请确认" : "Before you run"}
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 12, lineHeight: 1.8 }}>
              <li>✓ {lang === "zh" ? "钱包已签名" : "Wallet signed"} <span style={{ color: "var(--green)" }}>✓</span></li>
              <li>
                {lang === "zh" ? "已装 AI IDE 的 CLI：" : "An AI IDE with a CLI: "}
                Claude Code <span style={{ color: "var(--ink-faint)" }}> {lang === "zh" ? "或" : "or"} </span>Codex CLI
                <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>
                  {lang === "zh"
                    ? "Susurration 把每条信号交给你本地的 agent 来决策。它带着你的 CLAUDE.md、MCP servers、skills、记忆 — 这才是 你的 agent，不是裸大模型。不需要单独的 LLM API key。"
                    : "Susurration delegates every signal to your local agent — running with your CLAUDE.md, MCP servers, skills, memory. That's YOUR agent, not a naked LLM. No separate API key needed."}
                </div>
              </li>
            </ul>
          </div>

          {/* The one command — prefixed with a single space so zsh/bash with
              HIST_IGNORE_SPACE / HISTCONTROL=ignorespace won't record the
              token to ~/.zsh_history / ~/.bash_history. Both shells default
              to this behavior on modern macOS/Linux. */}
          <div className="d-code-block" style={{ marginBottom: 8 }}>
            <div className="d-code-block-label">
              <span>{lang === "zh" ? "在你的终端跑这一行" : "Run this in your terminal"}</span>
              <CopyBtn
                text={` npx -y @susurration/installer install --token ${authToken || "sk_live_YOUR_TOKEN"}`}
                className="copy-prominent"
              />
            </div>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.7 }}>
              <span className="tok-key">{" "}npx</span>
              {" "}
              <span className="tok-str">-y @susurration/installer install --token </span>
              <span className="tok-num">{maskToken(authToken || "sk_live_YOUR_TOKEN")}</span>
            </pre>
          </div>
          <div style={{ fontSize: 10, color: "var(--ink-faint)", marginBottom: 16, lineHeight: 1.6 }}>
            {lang === "zh"
              ? <>命令前有一个空格 — 现代 zsh / bash 在 <code>HIST_IGNORE_SPACE</code> / <code>HISTCONTROL=ignorespace</code> 默认开启时不会把这行记入 history（保护 token）。若你自定义过这个行为，跑完后可手动 <code>history -d -1</code> 清掉。</>
              : <>The command is prefixed with a space — modern zsh / bash with default <code>HIST_IGNORE_SPACE</code> / <code>HISTCONTROL=ignorespace</code> won't log this line to shell history (protects your token). If you've customized that setting, run <code>history -d -1</code> after to clear it.</>
            }
          </div>

          <div className="agent-tip" style={{ marginBottom: 16, lineHeight: 1.7 }}>
            {lang === "zh"
              ? <>
                  Installer 会做这 4 件事：<br/>
                  1. 检测你装好的所有 AI IDE<br/>
                  2. 装 daemon (<code style={{ background: "var(--surface-2, #1a1a1a)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>npm install -g susurration-agent-daemon</code>)<br/>
                  3. 写 MCP 配置到每个 IDE + 写 <code style={{ background: "var(--surface-2, #1a1a1a)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>~/.susu/agent-config.json</code><br/>
                  4. 启动 daemon
                  <div style={{ marginTop: 10, color: "var(--yellow, #f59e0b)" }}>
                    ⚠ 完成后必须<strong>完全退出 IDE（Cmd+Q）再重开</strong>，MCP 只在启动时加载。<code>/clear</code> 或新 tab 不行。
                  </div>
                </>
              : <>
                  Installer does these 4 things:<br/>
                  1. Detects all your installed AI IDEs<br/>
                  2. Installs the daemon (<code style={{ background: "var(--surface-2, #1a1a1a)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>npm install -g susurration-agent-daemon</code>)<br/>
                  3. Writes MCP config to each IDE + writes <code style={{ background: "var(--surface-2, #1a1a1a)", padding: "1px 4px", borderRadius: 3, fontSize: 11 }}>~/.susu/agent-config.json</code><br/>
                  4. Spawns the daemon
                  <div style={{ marginTop: 10, color: "var(--yellow, #f59e0b)" }}>
                    ⚠ When done you must <strong>completely quit your IDE (Cmd+Q) and reopen</strong>. MCP loads on startup only. <code>/clear</code> or a new tab will NOT work.
                  </div>
                </>
            }
          </div>

          {/* v4 Phase 7c — Connectivity test gate. Enter Dashboard is locked
              until a real signal → daemon eval → daemon react round-trip
              completes. This guarantees every user who lands on Dashboard
              has a working agent connection. */}
          <div style={{ marginTop: 20, padding: 14, background: "var(--surface-2, #141414)", border: "1px solid var(--border, #2a2a2a)", borderRadius: 6 }}>
            <div style={{ fontSize: 12, color: "var(--ink)", fontWeight: 500, marginBottom: 6 }}>
              {lang === "zh" ? "连通测试（必经一步）" : "Connectivity test (required)"}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.7, marginBottom: 12 }}>
              {lang === "zh"
                ? "点击下方按钮，我们会推一条真实的测试信号给你的 agent。只有你的 agent 收到、评估、并 react +1（自动开仓），下方「进入 Dashboard」按钮才会解锁。"
                : "Click below to push a real test signal to your agent. Enter Dashboard unlocks only after your agent receives → evaluates → reacts +1 (auto-opens a paper position)."
              }
            </div>

            {testStage === "idle" && (
              <div style={{
                fontSize: 11, lineHeight: 1.7, padding: "8px 10px",
                background: "rgba(245, 158, 11, 0.08)",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                borderRadius: 4, color: "var(--yellow, #f59e0b)",
                marginBottom: 12,
              }}>
                {lang === "zh"
                  ? <>⚠ <strong>必须先到终端跑完上面的命令</strong>，installer 提示完成后<strong>完全退出 IDE（Cmd+Q）并重开</strong>，daemon 才能启动。如果跳过这两步直接点测试，必然超时失败。</>
                  : <>⚠ <strong>You MUST run the command above in your terminal first</strong>, then <strong>fully quit your IDE (Cmd+Q) and reopen</strong> after installer says done. Skipping these two steps and clicking test will time out.</>
                }
              </div>
            )}

            {testStage === "idle" && (
              <>
                <label style={{
                  display: "flex", alignItems: "flex-start", gap: 8,
                  fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.7,
                  cursor: "pointer", padding: "6px 0", marginBottom: 12,
                  userSelect: "none",
                }}>
                  <input
                    type="checkbox"
                    checked={readyAcked}
                    onChange={(e) => setReadyAcked(e.target.checked)}
                    style={{ marginTop: 3, flexShrink: 0, cursor: "pointer" }}
                  />
                  <span>
                    {lang === "zh"
                      ? "我已经跑完 installer 命令，且完全退出并重开了 IDE"
                      : "I've run the installer command AND fully quit + reopened my IDE"
                    }
                  </span>
                </label>
                <button
                  className="ob-btn-next"
                  onClick={triggerConnectivityTest}
                  disabled={!readyAcked}
                  title={!readyAcked ? (lang === "zh" ? "请先勾选确认" : "Please confirm above first") : undefined}
                  style={{ width: "100%", opacity: readyAcked ? 1 : 0.5, cursor: readyAcked ? "pointer" : "not-allowed" }}
                >
                  {lang === "zh" ? "开始连通测试" : "Start connectivity test"}
                </button>
              </>
            )}

            {testStage === "pushing" && (
              <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                {lang === "zh" ? "正在推送测试信号…" : "Pushing test signal…"}
              </div>
            )}

            {testStage === "waiting_react" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{
                    display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                    background: "var(--green, #10b981)",
                    animation: "daemon-pulse 1.2s ease-in-out infinite",
                  }} />
                  <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                    {lang === "zh"
                      ? `信号已推送，等待 agent 反应… (${testElapsedSec}s / ${TEST_TIMEOUT_SEC}s)`
                      : `Signal pushed, waiting for agent to react… (${testElapsedSec}s / ${TEST_TIMEOUT_SEC}s)`
                    }
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-faint)", lineHeight: 1.6 }}>
                  {lang === "zh"
                    ? "如果迟迟没反应，最常见原因：① IDE 没完全重启（MCP 只在启动时加载）② 你的 IDE-agent CLI 没在 PATH 里（试 `which claude`）③ daemon 进程 crash（看 ~/.susu/agent-decisions.jsonl）"
                    : "Common stalls: ① IDE not fully restarted (MCP loads on startup only) ② your IDE-agent CLI is not on PATH (try `which claude`) ③ daemon crashed (check ~/.susu/agent-decisions.jsonl)"
                  }
                </div>
              </div>
            )}

            {testStage === "success" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ color: "var(--green, #10b981)", fontSize: 14, fontWeight: 600 }}>✓</span>
                  <span style={{ fontSize: 12, color: "var(--green, #10b981)" }}>
                    {lang === "zh" ? "连通正常！Agent 已开仓。" : "Connected! Agent opened a position."}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-faint)" }}>
                  {lang === "zh" ? "进入 Dashboard 后可在 Feed 流看到这条信号 + Positions 看到这笔仓位。" : "After entering Dashboard you'll see this signal in Feed + the position in Positions."}
                </div>
              </div>
            )}

            {testStage === "fail" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ color: "var(--red, #ef4444)", fontSize: 14, fontWeight: 600 }}>✗</span>
                  <span style={{ fontSize: 12, color: "var(--red, #ef4444)" }}>
                    {lang === "zh" ? "测试失败" : "Test failed"}
                  </span>
                </div>
                {testFailReason && (
                  <div style={{ fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.6, marginBottom: 10 }}>
                    {testFailReason}
                  </div>
                )}
                <button
                  className="ob-btn-back"
                  onClick={() => { setTestStage("idle"); setReadyAcked(false); setTestFailReason(null); }}
                  style={{ fontSize: 11, padding: "6px 14px" }}
                >
                  {lang === "zh" ? "重试" : "Retry"}
                </button>
              </div>
            )}
          </div>

          <div className="onboard-nav">
            <button className="ob-btn-back" onClick={() => goStep(2)}>{t("ob.back")}</button>
            <button
              className="ob-btn-next"
              disabled={testStage !== "success"}
              title={testStage !== "success" ? (lang === "zh" ? "请先完成连通测试" : "Complete connectivity test first") : undefined}
              onClick={() => {
                fireOnboardingEvent("enter_dashboard", { agent: "installer", result: "detected", context: { test_passed: "true" } });
                localStorage.setItem("susu_agent", "installer");
                onComplete();
              }}
            >{lang === "zh" ? "进入 Dashboard" : "Enter Dashboard"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   UPGRADE BANNER (Phase 16)
// ════════════════════════════════════════════════════════
// Sticky top-center pill that appears only when the caller's daemon is on
// an older version than npm latest. Click → copies the installer command to
// clipboard so user can paste-and-run in terminal.
//
// Server-side: identity.last_daemon_version (set on SSE connect via UA header)
//   vs GET /api/daemon/latest-version (cached npm registry fetch).
// Future Phase 17: real one-click via daemon localhost endpoint.

function semverLT(a: string, b: string): boolean {
  const pa = a.split(".").map(n => parseInt(n, 10));
  const pb = b.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

// Phase 17 — daemon's local HTTP server (loopback only).
const DAEMON_LOCAL_BASE = "http://127.0.0.1:7777";

type UpgradeState = "idle" | "probing" | "upgrading" | "polling" | "done" | "error";

function UpgradeBanner() {
  const { lang } = useLang();
  const auth = useAuth();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Phase 17 — one-click upgrade state
  const [oneClickReady, setOneClickReady] = useState<boolean | null>(null);
  const [upgradeState, setUpgradeState] = useState<UpgradeState>("idle");
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.token) return;
    let cancelled = false;
    Promise.all([
      apiFetch<{ last_daemon_version: string | null }>("/identity/whoami").catch(() => ({ last_daemon_version: null })),
      apiFetch<{ version: string | null }>("/daemon/latest-version").catch(() => ({ version: null })),
    ]).then(([me, latest]) => {
      if (cancelled) return;
      setCurrentVersion(me.last_daemon_version ?? null);
      setLatestVersion(latest.version ?? null);
    });
    return () => { cancelled = true; };
  }, [auth.token]);

  // Phase 18.2-w — lazy probe. We used to eager-probe the daemon localhost
  // /healthz as soon as needsUpgrade flipped true. That triggered a mixed-
  // content / CORS permission prompt in some browsers (HTTPS page reaching
  // http://127.0.0.1), even when the user never opened the banner and the
  // button label was the unrelated "Copy upgrade cmd" path. The two
  // surfaces were giving contradictory signals: button = copy intent,
  // browser = "site is asking for localhost permission, allow?". Confusing.
  //
  // Fix: don't probe at all on mount. Single click triggers the probe;
  // result decides one-click vs clipboard copy inline.
  const needsUpgrade =
    currentVersion != null &&
    latestVersion != null &&
    semverLT(currentVersion, latestVersion);

  const showBanner = !dismissed && needsUpgrade;
  if (!showBanner) return null;

  const installerCmd = ` npx -y @susurration/installer install --token ${auth.token ?? "sk_live_YOUR_TOKEN"}`;

  // Copy-command fallback. Used when daemon localhost probe fails or one-
  // click upgrade can't proceed (different machine, daemon stopped, older
  // daemon without /healthz, etc).
  const handleCopyClick = () => {
    navigator.clipboard.writeText(installerCmd).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 3000); },
      () => { /* clipboard denied; fallback: select text manually */ },
    );
    fetch(`${API}/onboarding/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({
        action: "upgrade_banner_click",
        context: { current: currentVersion, latest: latestVersion, path: "copy" },
      }),
      keepalive: true,
    }).catch(() => {});
  };

  // Phase 18.2-w — single click handler. Probes localhost daemon ON DEMAND,
  // then either runs one-click upgrade or falls back to copying the command.
  // No localhost requests happen until this fires, so passive page loads
  // never surface a mixed-content permission prompt.
  const handleUpgradeClick = async () => {
    // Lazy probe: try /healthz once (1.5s timeout). Network error / CORS /
    // daemon-not-running all map to "not reachable; copy instead".
    let ready = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`${DAEMON_LOCAL_BASE}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const data: any = await r.json().catch(() => null);
        ready = !!data && typeof data.upgrade_endpoint === "string";
      }
    } catch { /* unreachable */ }

    setOneClickReady(ready);
    if (ready) {
      await handleOneClickUpgrade();
    } else {
      handleCopyClick();
    }
  };

  // One-click path. POSTs to local daemon, then polls /healthz until version updates.
  const handleOneClickUpgrade = async () => {
    setUpgradeState("upgrading");
    setUpgradeError(null);
    fetch(`${API}/onboarding/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({
        action: "upgrade_banner_click",
        context: { current: currentVersion, latest: latestVersion, path: "one_click" },
      }),
      keepalive: true,
    }).catch(() => {});

    let upgradeResp: any = null;
    try {
      // npm install can take ~30-60s; allow 2 min upper bound.
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 150_000);
      const r = await fetch(`${DAEMON_LOCAL_BASE}/upgrade`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);
      upgradeResp = await r.json().catch(() => null);
      if (!r.ok) {
        setUpgradeState("error");
        setUpgradeError(upgradeResp?.error ? `${upgradeResp.error}${upgradeResp.hint ? ": " + upgradeResp.hint : ""}` : `HTTP ${r.status}`);
        return;
      }
    } catch (err) {
      setUpgradeState("error");
      setUpgradeError((err as Error).message ?? "request failed");
      return;
    }

    // already_latest → daemon claims it's already on latest. Verify against
    // server's last_daemon_version (set from SSE UA, authoritative).
    //
    // Three cases:
    //   A. server matches latest → trust both, set done
    //   B. server has older version → daemon was upgraded out-of-band but not
    //      restarted (manual npm install with no restart). Real error.
    //   C. server has null → daemon hasn't reconnected SSE since boot, server
    //      just doesn't know yet. Treat as soft-success: trust daemon.
    if (upgradeResp?.status === "already_latest") {
      try {
        const me = await apiFetch<{ last_daemon_version: string | null }>("/identity/whoami");
        let serverVersion = me.last_daemon_version;
        if (serverVersion && latestVersion && !semverLT(serverVersion, latestVersion)) {
          setUpgradeState("done");
          setCurrentVersion(serverVersion);
          return;
        }
        await new Promise(r => setTimeout(r, 5_000));
        const me2 = await apiFetch<{ last_daemon_version: string | null }>("/identity/whoami").catch(() => null);
        serverVersion = me2?.last_daemon_version ?? serverVersion;
        if (serverVersion && latestVersion && !semverLT(serverVersion, latestVersion)) {
          setUpgradeState("done");
          setCurrentVersion(serverVersion);
          return;
        }
        if (!serverVersion) {
          // Case C — server hasn't seen the daemon yet. Trust daemon self-report.
          setUpgradeState("done");
          setCurrentVersion(latestVersion);
          return;
        }
        // Case B — server has stale version. Real mismatch worth surfacing.
        setUpgradeState("error");
        setUpgradeError(lang === "zh"
          ? `Daemon 自报已是最新但服务端记录的是 v${serverVersion}，请手动重启 daemon`
          : `Daemon claims latest but server records v${serverVersion} — restart daemon manually`);
      } catch {
        setUpgradeState("error");
        setUpgradeError(lang === "zh" ? "无法验证升级状态" : "Could not verify upgrade status");
      }
      return;
    }

    // upgrading → daemon is restarting. Poll /healthz until version bumps.
    setUpgradeState("polling");
    const pollDeadline = Date.now() + 60_000;  // 1 min ceiling
    const target = latestVersion;
    while (Date.now() < pollDeadline) {
      await new Promise(r => setTimeout(r, 2_000));
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const hc = await fetch(`${DAEMON_LOCAL_BASE}/healthz`, { signal: ctrl.signal });
        clearTimeout(t);
        if (hc.ok) {
          const data = await hc.json() as { version?: string };
          if (data.version && target && !semverLT(data.version, target) && data.version !== currentVersion) {
            setUpgradeState("done");
            setCurrentVersion(data.version);
            return;
          }
        }
      } catch { /* still restarting */ }
    }
    // Timed out — give up gracefully. Old daemon is dead, new daemon may have
    // failed to spawn. Tell user to check manually.
    setUpgradeState("error");
    setUpgradeError(lang === "zh"
      ? "升级后 daemon 未在 60 秒内启动，请手动重启"
      : "Daemon did not start within 60s after upgrade — restart manually");
  };

  // Phase 18.2-w — single click handler that decides one-click vs copy
  // after probing daemon on demand. The label is one of: neutral
  // "Upgrade" before user interacts, or a state-specific string after.
  const handleClick = handleUpgradeClick;

  let buttonLabel: string;
  if (upgradeState === "upgrading") {
    buttonLabel = lang === "zh" ? "升级中…" : "Upgrading…";
  } else if (upgradeState === "polling") {
    buttonLabel = lang === "zh" ? "重启 daemon 中…" : "Restarting daemon…";
  } else if (upgradeState === "done") {
    buttonLabel = lang === "zh" ? "✓ 已升级" : "✓ Upgraded";
  } else if (copied) {
    buttonLabel = lang === "zh" ? "✓ 已复制 — 粘贴到终端" : "✓ Copied — paste in terminal";
  } else if (upgradeState === "error") {
    buttonLabel = lang === "zh" ? "重试" : "Try again";
  } else {
    buttonLabel = lang === "zh" ? "升级" : "Upgrade";
  }
  const busy = upgradeState === "upgrading" || upgradeState === "polling";
  const buttonGreen = copied || upgradeState === "done";

  return (
    <div style={{
      position: "fixed",
      top: 12,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 100,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "8px 14px 8px 16px",
      background: "var(--surface3)",
      border: "0.5px solid var(--accent-border)",
      borderRadius: "var(--radius-pill, 999px)",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
      fontSize: 12,
      fontFamily: "var(--mono)",
      color: "var(--ink)",
      maxWidth: "calc(100vw - 24px)",
    }}>
      <span style={{
        display: "inline-block", width: 6, height: 6, borderRadius: "50%",
        background: "var(--accent, #7aa2f7)",
        animation: "daemon-pulse 1.6s ease-in-out infinite",
      }} />
      <span style={{ color: "var(--ink-soft)" }}>
        {lang === "zh"
          ? <>Daemon 新版可用 <span style={{ color: "var(--ink-faint)" }}>v{currentVersion}</span> → <span style={{ color: "var(--accent, #7aa2f7)" }}>v{latestVersion}</span></>
          : <>Daemon update <span style={{ color: "var(--ink-faint)" }}>v{currentVersion}</span> → <span style={{ color: "var(--accent, #7aa2f7)" }}>v{latestVersion}</span></>
        }
      </span>
      <button
        onClick={handleClick}
        disabled={busy || upgradeState === "done"}
        title={upgradeError ?? undefined}
        style={{
          background: buttonGreen ? "var(--green)" : "var(--accent, #7aa2f7)",
          color: "#0b0f1a",
          border: "none",
          padding: "4px 12px",
          borderRadius: "var(--radius-sm, 4px)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 500,
          cursor: busy || upgradeState === "done" ? "default" : "pointer",
          opacity: busy ? 0.7 : 1,
          letterSpacing: "0.3px",
          transition: "background 120ms ease",
          whiteSpace: "nowrap",
        }}
      >
        {buttonLabel}
      </button>
      <button
        onClick={() => setDismissed(true)}
        title={lang === "zh" ? "本次会话不再提示" : "Dismiss for this session"}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--ink-faint)",
          cursor: "pointer",
          fontSize: 14,
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   SIDEBAR
// ════════════════════════════════════════════════════════
// v4 — Daemon alive indicator (5 states based on last_daemon_ping_at + last_mcp_ping_at)
type DaemonAliveState = "never" | "down" | "lagging" | "alive" | "connecting";
function DaemonAliveIndicator() {
  const { lang } = useLang();
  const [state, setState] = useState<DaemonAliveState>("connecting");
  const [lastPingSec, setLastPingSec] = useState<number | null>(null);
  const auth = useAuth();
  useEffect(() => {
    if (!auth.token) return;
    let cancelled = false;
    const poll = () => {
      apiFetch<{ last_daemon_ping_at: string | null; last_mcp_ping_at: string | null; created_at: string | null }>("/identity/whoami").then(me => {
        if (cancelled) return;
        // Daemon ping wins over MCP ping (daemon is what evaluates signals)
        const pingIso = me.last_daemon_ping_at ?? me.last_mcp_ping_at ?? null;
        if (!pingIso) {
          // NEVER vs CONNECTING: if account < 90s old, still in CONNECTING (give installer time)
          const accountAgeSec = me.created_at ? (Date.now() - new Date(me.created_at).getTime()) / 1000 : Infinity;
          setState(accountAgeSec < 90 ? "connecting" : "never");
          setLastPingSec(null);
          return;
        }
        const agoSec = Math.floor((Date.now() - new Date(pingIso).getTime()) / 1000);
        setLastPingSec(agoSec);
        // Backend SSE heartbeat updates last_daemon_ping_at every 3 min
        // (signals.ts:883 DAEMON_PING_INTERVAL). Thresholds tuned to match:
        //   alive:    < 4 min (one ping cycle + 1 min jitter for fly proxy)
        //   lagging:  4-10 min (missed 1-3 cycles)
        //   down:     > 10 min (sustained disconnect)
        if (agoSec < 4 * 60) setState("alive");
        else if (agoSec < 10 * 60) setState("lagging");
        else setState("down");
      }).catch(() => { /* don't flip state on network blip */ });
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [auth.token]);

  const cfg: Record<DaemonAliveState, { color: string; label: { en: string; zh: string }; tooltip: { en: string; zh: string } }> = {
    alive: { color: "#10B981", label: { en: "Agent online", zh: "Agent 在线" }, tooltip: { en: "Last ping under 30s ago", zh: "最近心跳 < 30 秒" } },
    lagging: { color: "#A1A1AA", label: { en: "Agent lagging", zh: "Agent 延迟" }, tooltip: { en: "Last ping 30s-5min ago", zh: "心跳 30 秒至 5 分钟" } },
    down: { color: "#EF4444", label: { en: "Agent offline", zh: "Agent 离线" }, tooltip: { en: "No ping in >5min", zh: "5 分钟无心跳" } },
    never: { color: "#3F3F46", label: { en: "No agent yet", zh: "未连接 agent" }, tooltip: { en: "Run installer in your terminal", zh: "去终端跑 installer" } },
    connecting: { color: "#10B981", label: { en: "Connecting…", zh: "连接中…" }, tooltip: { en: "Waiting for first daemon ping", zh: "等待 daemon 首次心跳" } },
  };
  const c = cfg[state];
  const label = lang === "zh" ? c.label.zh : c.label.en;
  const tooltip = lang === "zh" ? c.tooltip.zh : c.tooltip.en;
  const fireEvent = useCallback((action: "view" | "click") => {
    const tk = localStorage.getItem("susu_token");
    if (!tk) return;
    const eventType = action === "view" ? "dashboard_indicator_view" : "dashboard_indicator_click";
    fetch(`${API}/onboarding/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ action: eventType, context: { state, last_ping_sec: lastPingSec ?? -1 } }),
      keepalive: true,
    }).catch(() => {});
  }, [state, lastPingSec]);
  // Fire view event ONCE on mount only — state oscillation (alive↔lagging) would
  // otherwise generate N events per session, polluting analytics.
  const viewFiredRef = useRef(false);
  useEffect(() => {
    if (viewFiredRef.current) return;
    viewFiredRef.current = true;
    fireEvent("view");
  }, [fireEvent]);
  // 放在 page-header 右上角（pill 风格）。alive 绿点呼吸 + 文字"连接正常"。
  // 其他状态相应。Sidebar bottom 不再显示（避免冗余）。
  const pingSuffix = lastPingSec !== null && state !== "connecting" ? ` · ${lastPingSec}s` : "";
  // alive 也呼吸，让"agent 在工作"有视觉反馈（Haze 要求）
  const shouldPulse = state === "alive" || state === "connecting";
  const friendlyLabel: Record<DaemonAliveState, { en: string; zh: string }> = {
    alive: { en: "Connected", zh: "连接正常" },
    lagging: { en: "Lagging", zh: "代理延迟" },
    down: { en: "Offline", zh: "代理离线" },
    never: { en: "Not connected", zh: "未连接" },
    connecting: { en: "Connecting…", zh: "连接中…" },
  };
  const labelTxt = lang === "zh" ? friendlyLabel[state].zh : friendlyLabel[state].en;
  return (
    <div
      className={`daemon-alive-indicator daemon-alive-${state}`}
      title={`${labelTxt}${pingSuffix}\n${tooltip}`}
      aria-label={`${labelTxt}${pingSuffix}`}
      onClick={() => fireEvent("click")}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "5px 12px", borderRadius: 999,
        cursor: "pointer", transition: "background 0.15s",
        background: "var(--surface2, rgba(255,255,255,0.04))",
        border: "0.5px solid var(--border2, rgba(255,255,255,0.08))",
        fontSize: 11, color: "var(--ink-soft)",
        userSelect: "none",
      }}
    >
      <span
        className="daemon-dot"
        style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%",
          background: c.color, flexShrink: 0,
          animation: shouldPulse ? "daemon-pulse 1.6s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{ whiteSpace: "nowrap" }}>{labelTxt}</span>
    </div>
  );
}

// ── Bottom status bar — daemon ● + wallet + peer-id (trade.xyz-style) ──
function StatusBar() {
  const auth = useAuth();
  if (!auth.token) return null;
  const handle = auth.username;
  const addr = auth.address;
  const walletShort = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : null;
  const peerId = handle ?? (addr ? addr.slice(0, 8) : null);
  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <DaemonAliveIndicator />
      </div>
      <div className="status-bar-right">
        {walletShort && <span className="status-item">wallet:<span className="status-mono">{walletShort}</span></span>}
        {peerId && <span className="status-item">⊶ <span className="status-mono">{peerId}</span></span>}
      </div>
    </div>
  );
}

function Sidebar({ page, setPage, hasNewActivity }: { page: Page; setPage: (p: Page) => void; hasNewActivity: boolean }) {
  const { t } = useLang();
  const items: { id: Page; tip: string; label: string; icon: React.ReactNode; badge?: boolean }[] = [
    { id: "dashboard", tip: t("tip.dashboard"), label: t("tip.dashboard"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="9" y="1.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="1.5" y="9" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="9" y="9" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    )},
    { id: "feed", tip: t("tip.activity"), label: t("tip.activity"), badge: hasNewActivity, icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    )},
    { id: "friends", tip: t("tip.friends"), label: t("tip.friends"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="6" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M1 13c0-2.76 2.24-5 5-5h0c2.76 0 5 2.24 5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="12" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M12 10.5c1.66 0 3 1.34 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    )},
    { id: "mode", tip: t("tip.mode"), label: t("tip.mode"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 13V8l4-5 4 5v5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        <path d="M4 13h8" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="8" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    )},
    { id: "settings", tip: t("tip.settings"), label: t("tip.settings"), icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M10.3 2.3l-.4 1.9c-.6.2-1.1.5-1.6.9L6.5 4.5l-1.7 3 1.4 1.4c-.1.4-.1.7-.1 1.1s0 .7.1 1.1l-1.4 1.4 1.7 3 1.8-.6c.5.4 1 .7 1.6.9l.4 1.9h3.4l.4-1.9c.6-.2 1.1-.5 1.6-.9l1.8.6 1.7-3-1.4-1.4c.1-.4.1-.7.1-1.1s0-.7-.1-1.1l1.4-1.4-1.7-3-1.8.6c-.5-.4-1-.7-1.6-.9l-.4-1.9h-3.4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
      </svg>
    )},
  ];

  return (
    <nav className="dash-sidebar">
      <div className="sidebar-logo">
        <svg width="24" height="24" viewBox="0 0 32 32" fill="none">
          <path d="M281 -9Q222 -9 177.5 10.0Q133 29 107.5 62.5Q82 96 78 142H186Q190 115 215.0 98.5Q240 82 281 82H324Q373 82 398.0 102.0Q423 122 423 155Q423 187 400.5 205.5Q378 224 334 230L263 241Q175 255 133.5 291.5Q92 328 92 400Q92 476 141.5 517.5Q191 559 288 559H326Q412 559 463.5 519.5Q515 480 522 414H414Q410 438 387.5 453.0Q365 468 326 468H288Q241 468 219.5 450.5Q198 433 198 399Q198 369 217.0 354.0Q236 339 276 333L349 321Q442 308 485.5 269.5Q529 231 529 158Q529 79 477.5 35.0Q426 -9 324 -9Z" fill="#a5b4c7" transform="translate(9.40 24.00) scale(0.02200 -0.02200)"/>
        </svg>
      </div>
      <div className="sidebar-nav">
        {items.map((item) => (
          <button key={item.id} className={`d-nav-item ${page === item.id ? "active" : ""}`} data-tip={item.tip} data-page={item.id} onClick={() => setPage(item.id)}>
            {item.badge && <div className="dot-badge" />}
            {item.icon}
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-bottom">
        <LangToggle />
        <div className="avatar-btn">{(useAuth().username || "?")[0]!.toUpperCase()}</div>
      </div>
    </nav>
  );
}

// ════════════════════════════════════════════════════════
//   DASHBOARD HOME
// ════════════════════════════════════════════════════════
function DashHome() {
  const { t, lang } = useLang();
  const auth = useAuth();
  const navigate = useNav();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsReady, setFriendsReady] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [persistedCloses, setPersistedCloses] = useState<Map<string, CloseRecord>>(new Map());

  const { setHasNew } = useContext(ActivityBadgeContext);

  // v4 self-heal: if register-time ensureDemoFriend hit a transient DB error
  // and never retried, the user lands on an empty dashboard with no signal source.
  // After first /friends fetch returns 0-demo, try to add @demo once. Idempotent
  // server-side: if already friends, /friends/add returns "already_friends" 200,
  // no-op. Guarded by localStorage so we only attempt once per browser.
  const selfHealedRef = useRef(false);
  useEffect(() => {
    if (selfHealedRef.current) return;
    if (!friendsReady) return;
    if (localStorage.getItem("susu_demo_selfheal_done") === "1") return;
    const hasDemo = friends.some((f) => f.friend_username === "demo");
    if (hasDemo) {
      localStorage.setItem("susu_demo_selfheal_done", "1");
      return;
    }
    selfHealedRef.current = true;
    apiFetch("/friends/add", { method: "POST", body: JSON.stringify({ username: "demo" }) })
      .then(() => {
        localStorage.setItem("susu_demo_selfheal_done", "1");
        // Re-fetch friends so the UI updates without page reload
        apiFetch<{ friends: Friend[] }>("/friends").then((r) => setFriends(r.friends)).catch(() => {});
      })
      .catch((err) => {
        // Don't poison the flag — let next dashboard load retry. But cap a
        // soft attempt window so we don't pound the endpoint every page view.
        console.warn("[demo-selfheal] add @demo failed:", err?.message);
      });
  }, [friendsReady, friends]);

  // Phase 11a — server-side paper positions (cross-device source of truth).
  // When daemon (>= v0.0.X with sync) has been pushing, this returns full
  // open + closed history. When empty (old daemon / no daemon yet), falls
  // back to feed-derived positions below.
  const [serverPositions, setServerPositions] = useState<any[]>([]);

  const fetchData = useCallback(() => {
    apiFetch<{ friends: Friend[] }>("/friends").then(r => { setFriends(r.friends); setFriendsReady(true); }).catch(() => { setFriendsReady(true); });
    apiFetch<{ events: FeedItem[] }>("/signals/feed?limit=200").then(r => {
      const events = r.events ?? [];
      setFeed(events);
      if (events.length > 0) {
        const lastSeen = parseInt(localStorage.getItem("susu_feed_seen_at") || "0");
        if (new Date(events[0]!.created_at).getTime() > lastSeen) setHasNew(true);
      }
    }).catch(() => {});
    apiFetch<{ closes: { signal_id: string; exit_reason: string; exit_price: number; exit_pnl_pct: number }[] }>("/positions/closed")
      .then(r => {
        const m = new Map<string, CloseRecord>();
        for (const c of r.closes) m.set(c.signal_id, { exit_reason: c.exit_reason, exit_price: c.exit_price, exit_pnl_pct: c.exit_pnl_pct });
        setPersistedCloses(m);
      }).catch(e => console.warn("[positions/closed] fetch failed:", e.message));
    // Phase 11a — pull server-side paper positions (auth-bound to caller).
    apiFetch<{ positions: any[] }>("/positions/mine?status=all")
      .then(r => setServerPositions(r.positions ?? []))
      .catch(e => console.warn("[positions/mine] fetch failed:", e.message));
  }, []);

  useEffect(() => {
    fetchData();
    const poll = setInterval(fetchData, 30_000);
    return () => clearInterval(poll);
  }, [fetchData]);

  const refreshPositions = useCallback(() => {
    if (!auth.address) return;
    // Phase 11a — server-side positions take precedence (cross-device truth).
    // Fallback to feed-derived for old daemons that haven't synced yet.
    //
    // Phase 17.5 (G review fix) — when raw comes from serverPositions, paper_positions
    // table already carries authoritative close data (closed_at + exit_*). DO NOT
    // overlay persistedCloses (the legacy /positions/closed → position_closes table),
    // which has independently-computed exit_pnl_pct from server position_closer
    // ticks and would corrupt the server-truth close info. persistedCloses is only
    // valid as a fallback for feed-derived raw positions (pre-Phase-11a daemons).
    let raw: Position[] = [];
    let fromServerTable = false;
    if (serverPositions.length > 0) {
      fromServerTable = true;
      raw = serverPositions.map((p): Position => ({
        token: p.token,
        direction: p.direction === "short" ? "short" : "long",
        leverage: p.leverage ?? 3,
        entryPrice: p.entry_price,
        stopLoss: p.stop_loss,
        takeProfit: p.take_profit,
        peer: p.peer_username ? `@${p.peer_username}` : "—",
        signalId: p.signal_id,
        openedAt: p.opened_at,
        status: p.closed_at ? "closed" : "open",
        positionUsd: p.position_usd,
        isReplay: !!p.is_replay,
        isBackfilled: !!p.is_backfilled,
        ...(p.closed_at ? {
          exitPrice: p.exit_price,
          exitReason: p.exit_reason,
          pnlPct: p.exit_pnl_pct,
          pnlUsd: p.exit_pnl_usd,
        } : {}),
      }));
    } else if (feed.length > 0) {
      raw = buildPositions(feed, auth.address);
    }
    if (raw.length === 0) { setPositions([]); setPricesLoaded(true); return; }
    const openSymbols = [...new Set(raw.filter(p => p.status === "open").map(p => p.token))].join(",");
    if (!openSymbols) { setPositions(raw); setPricesLoaded(true); return; }
    const closesForOverlay = fromServerTable ? new Map<string, CloseRecord>() : persistedCloses;
    apiFetch<{ prices: Record<string, number> }>(`/prices?symbols=${openSymbols}`)
      .then(r => {
        const { positions: updated } = applyPrices(raw, r.prices, closesForOverlay);
        setPositions(updated);
        setPricesLoaded(true);
      })
      .catch(() => { setPositions(raw); setPricesLoaded(true); });
  }, [feed, serverPositions, auth.address, persistedCloses]);

  useEffect(() => {
    refreshPositions();
    const poll = setInterval(refreshPositions, 5_000);
    return () => clearInterval(poll);
  }, [refreshPositions]);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaySignals = feed.filter(f => f.kind === "signal" && new Date(f.created_at) >= todayStart).length;

  // v4: replay positions are dry-run demos — excluded from PnL aggregates
  // so users don't accidentally treat demo PnL as real performance.
  // Phase 17.5: backfilled positions have position_usd=0 (unrecoverable) so
  // their pnlUsd is unreliable; they show up in the closed list (tagged
  // "*历史推断*") but are excluded from total $ aggregates. Their pnl_pct is
  // still authoritative (came from position_closes table) so they DO count
  // toward the % win-rate stats.
  const realPositions = positions.filter(p => !p.isReplay);
  const moneyAccountable = realPositions.filter(p => !p.isBackfilled);
  const totalPnl = moneyAccountable.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const totalCapital = moneyAccountable.reduce((s, p) => s + p.positionUsd, 0);
  // Phase 14 G #3 — totalPnlPct uses % directly from positions (which DO have
  // real pnlPct from price math) so we can show meaningful % even when
  // positionUsd=0 (feed-derived fallback before daemon syncs to server).
  const realPnlPctSum = realPositions.reduce((s, p) => s + (p.pnlPct ?? 0), 0);
  const realPnlPctAvg = realPositions.length > 0 ? realPnlPctSum / realPositions.length : 0;
  const totalPnlPct = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : realPnlPctAvg;
  const openPositions = realPositions.filter(p => p.status === "open").sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const closedPositions = realPositions.filter(p => p.status === "closed").sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const demoPositions = positions.filter(p => p.isReplay).sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const hasPositions = realPositions.length > 0;
  // Phase 15 — fallback detection: if all real positions have positionUsd=0
  // it means daemon hasn't synced to server yet (old daemon or new device
  // first-load). Show "% only / $ pending sync" instead of fake $0.00.
  const isPendingSync = hasPositions && totalCapital === 0;

  const pnlColor = totalPnlPct > 0 ? "var(--green)" : totalPnlPct < 0 ? "var(--red)" : "var(--ink-faint)";
  const pnlSign = totalPnlPct > 0 ? "+" : totalPnlPct < 0 ? "-" : "";

  return (
    <div className="d-page active" style={{ display: "flex" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("dash.title")}</strong></div>
      </div>
      <div className="dash-body">
        <div className="stat-row">
          <div className="stat-card">
            <div className="stat-label">{t("dash.todaySignals")}</div>
            <div className="stat-value">{todaySignals}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t("dash.activeFriends")}</div>
            <div className="stat-value">{friends.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t("dash.pnl")} <span style={{ textTransform: "none", letterSpacing: 0, opacity: 0.7 }}>· {t("dash.fromSignals")}</span></div>
            {hasPositions && pricesLoaded ? (
              <>
                {/* Phase 15 — pending-sync fallback: show % avg only + hint
                    when daemon hasn't synced position_usd to server yet. */}
                {isPendingSync ? (
                  <>
                    <div className="stat-value" style={{ color: pnlColor }}>
                      {pnlSign}{Math.abs(totalPnlPct).toFixed(1)}%
                      <span style={{ fontSize: 11, color: "var(--ink-faint)", marginLeft: 8, fontWeight: 400 }}>
                        · {lang === "zh" ? "$ 待同步" : "$ pending sync"}
                      </span>
                    </div>
                    <div className="stat-sub" style={{ fontSize: 10, color: "var(--ink-faint)" }}>
                      {openPositions.length} {t("dash.posOpen")} · {closedPositions.length} {t("dash.posClosed")}
                      {" · "}
                      <span title={lang === "zh" ? "升级 daemon 到 0.0.16+ 后跨设备同步美元金额" : "Upgrade daemon to 0.0.16+ for cross-device USD sync"}>
                        {lang === "zh" ? "升级 daemon 看 $" : "upgrade daemon for $"}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="stat-value" style={{ color: pnlColor }}>{pnlSign}${Math.abs(totalPnl).toFixed(2)} <span style={{ fontSize: 14, color: pnlColor }}>({pnlSign}{Math.abs(totalPnlPct).toFixed(1)}%)</span></div>
                    <div className="stat-sub" style={{ fontSize: 10, color: "var(--ink-faint)" }}>
                      {openPositions.length} {t("dash.posOpen")} · {closedPositions.length} {t("dash.posClosed")}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="stat-value" style={{ color: "var(--ink-faint)" }}>—</div>
            )}
          </div>
        </div>

        {friendsReady && todaySignals === 0 && friends.length === 0 && (
          <div className="positions-card" style={{ textAlign: "center", padding: "32px 16px" }}>
            <div style={{ fontSize: 13, color: "var(--ink-faint)", marginBottom: 12 }}>{t("dash.noSignalsSub")}</div>
            <button className="btn-primary" style={{ fontSize: 12, padding: "8px 20px" }} onClick={() => navigate("friends")}>{t("dash.addFirstFriend")}</button>
          </div>
        )}

        {friendsReady && friends.length > 0 && todaySignals === 0 && (
          <AwaitingSignalCard />
        )}

        <div className="positions-card">
          <div className="section-header">
            <span className="section-title">{t("dash.openPositions")}</span>
            {openPositions.length > 0 && <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{openPositions.length}</span>}
          </div>
          {openPositions.length > 0 ? (
            <div className="positions-table">
              <div className="positions-header">
                <span>{t("dash.colToken")}</span>
                <span>{t("dash.colDir")}</span>
                <span>{t("dash.colEntry")}</span>
                <span>{t("dash.colCurrent")}</span>
                <span>{t("dash.colSize")}</span>
                <span>{t("dash.colPnl")}</span>
                <span>{t("dash.colFrom")}</span>
              </div>
              {openPositions.map(pos => {
                const c = (pos.pnlPct ?? 0) >= 0 ? "var(--green)" : "var(--red)";
                const s = (pos.pnlPct ?? 0) >= 0 ? "+" : "";
                return (
                  <div className="positions-row" key={pos.signalId}>
                    <span className="pos-token">{pos.token.replace(/USDT$/, "")}</span>
                    <span className={`pos-dir ${pos.direction}`}>{pos.direction.toUpperCase()} {pos.leverage}x</span>
                    <span className="pos-price">${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className="pos-price">{pos.currentPrice !== undefined ? `$${pos.currentPrice < 1 ? pos.currentPrice.toPrecision(4) : pos.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</span>
                    <span className="pos-price">${pos.positionUsd.toFixed(0)}</span>
                    <span style={{ color: c, fontVariantNumeric: "tabular-nums" }}>{s}{(pos.pnlPct ?? 0).toFixed(2)}%</span>
                    <span className="pos-peer">{pos.peer}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: "24px 0", textAlign: "center", fontSize: 12, color: "var(--ink-faint)" }}>
              {t("dash.noPositions")}
            </div>
          )}
        </div>

        {/* v4: demo positions from replay signals — physically separated so users
            don't confuse the demo PnL with their real performance. */}
        {demoPositions.length > 0 && (
          <div className="positions-card" style={{ marginTop: 12, borderStyle: "dashed", borderColor: "var(--border-light, #333)" }}>
            <div className="section-header">
              <span className="section-title" style={{ color: "var(--ink-soft)" }}>
                {lang === "zh" ? "演示仓位" : "Demo positions"}
                <span style={{ marginLeft: 8, fontSize: 10, color: "var(--ink-faint)", textTransform: "none", letterSpacing: 0 }}>
                  {lang === "zh" ? "（不计入统计）" : "(not counted in stats)"}
                </span>
              </span>
              <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{demoPositions.length}</span>
            </div>
            <div className="positions-table">
              <div className="positions-header">
                <span>{t("dash.colToken")}</span>
                <span>{t("dash.colDir")}</span>
                <span>{t("dash.colEntry")}</span>
                <span>{t("dash.colCurrent")}</span>
                <span>{t("dash.colSize")}</span>
                <span>{t("dash.colPnl")}</span>
                <span>{t("dash.colFrom")}</span>
              </div>
              {demoPositions.map(pos => {
                const c = (pos.pnlPct ?? 0) >= 0 ? "var(--green)" : "var(--red)";
                const s = (pos.pnlPct ?? 0) >= 0 ? "+" : "";
                return (
                  <div className="positions-row" key={pos.signalId} style={{ opacity: 0.75 }}>
                    <span className="pos-token">
                      {pos.token.replace(/USDT$/, "")}
                      <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", border: "1px dashed var(--ink-faint)", borderRadius: 3, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                        {lang === "zh" ? "演示" : "DEMO"}
                      </span>
                    </span>
                    <span className={`pos-dir ${pos.direction}`}>{pos.direction.toUpperCase()} {pos.leverage}x</span>
                    <span className="pos-price">${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className="pos-price">{pos.currentPrice !== undefined ? `$${pos.currentPrice < 1 ? pos.currentPrice.toPrecision(4) : pos.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</span>
                    <span style={{ color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>~${pos.positionUsd.toFixed(0)}</span>
                    <span style={{ color: c, fontVariantNumeric: "tabular-nums" }}>{pos.pnlPct !== undefined ? `~${s}${pos.pnlPct.toFixed(2)}%` : "—"}</span>
                    <span className="pos-peer">{pos.peer}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {closedPositions.length > 0 && (
          <div className="positions-card" style={{ marginTop: 12 }}>
            <div className="section-header">
              <span className="section-title">{t("dash.closedPositions")}</span>
              <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{closedPositions.length}</span>
            </div>
            <div className="positions-table closed-table">
              <div className="positions-header">
                <span>{t("dash.colToken")}</span>
                <span>{t("dash.colDir")}</span>
                <span>{t("dash.colPriceMove")}</span>
                <span>{t("dash.colPnl")}</span>
                <span>{t("dash.colReason")}</span>
              </div>
              {closedPositions.map(pos => {
                const c = (pos.pnlPct ?? 0) >= 0 ? "var(--green)" : "var(--red)";
                const s = (pos.pnlPct ?? 0) >= 0 ? "+" : "";
                const fmtPrice = (p: number) => p < 1 ? p.toPrecision(4) : p.toLocaleString(undefined, { maximumFractionDigits: 2 });
                return (
                  <div className="positions-row" key={pos.signalId}>
                    <span className="pos-token">
                      {pos.token.replace(/USDT$/, "")}
                      {pos.isBackfilled && (
                        <span className="backfill-tag">
                          *{lang === "zh" ? "历史推断" : "inferred"}*
                          <span className="backfill-tag-tooltip">
                            {lang === "zh"
                              ? "Phase 11a 之前的成交,只能从信号回推 entry/SL/TP;仓位金额不可考。"
                              : "Reconstructed from pre-Phase-11a signals. Entry/SL/TP recovered, but position size is unrecoverable."}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className={`pos-dir ${pos.direction}`}>{pos.direction.toUpperCase()} {pos.leverage}x</span>
                    <span className="pos-price-move">
                      <span>${fmtPrice(pos.entryPrice)}</span>
                      <span className="pos-arrow">→</span>
                      <span>{pos.exitPrice !== undefined ? `$${fmtPrice(pos.exitPrice)}` : "—"}</span>
                    </span>
                    <span style={{ color: c, fontVariantNumeric: "tabular-nums" }}>{s}{(pos.pnlPct ?? 0).toFixed(2)}%</span>
                    <span className="pos-peer" style={{ color: c }}>{pos.exitReason}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   FEED PAGE
// ════════════════════════════════════════════════════════
function FeedPage() {
  const { t, lang } = useLang();
  const auth = useAuth();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState("all");

  useEffect(() => {
    apiFetch<{ events: FeedItem[] }>("/signals/feed?limit=200")
      .then(r => setFeed(r.events ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Phase 14 G #4 — was rebuilding all 3 Maps on every render (input typing
  // anywhere in tree triggered O(N) re-walks of feed). useMemo([feed]) caches
  // until feed changes (every 30s poll or SSE).
  const { reactionCounts, reactionsMap } = React.useMemo(() => {
    const counts = new Map<string, { agrees: number; against: number }>();
    const map = new Map<string, FeedItem[]>();
    for (const f of feed) {
      if (f.kind !== "reaction" || !f.parent_signal_id) continue;
      const c = counts.get(f.parent_signal_id) ?? { agrees: 0, against: 0 };
      if (f.payload?.value === "+1") c.agrees++;
      else if (f.payload?.value === "-1") c.against++;
      counts.set(f.parent_signal_id, c);
      const list = map.get(f.parent_signal_id) ?? [];
      list.push(f);
      map.set(f.parent_signal_id, list);
    }
    return { reactionCounts: counts, reactionsMap: map };
  }, [feed]);

  // My action on each signal — for "why not opened" transparency
  const myReactions = React.useMemo(() => {
    const m = new Map<string, FeedItem>();
    for (const f of feed) {
      if (f.kind === "reaction" && f.from_address === auth.address && f.parent_signal_id) {
        if (!m.has(f.parent_signal_id)) m.set(f.parent_signal_id, f);
      }
    }
    return m;
  }, [feed, auth.address]);

  // Phase 10 D7 — channel structural events come through feed REST query as
  // these distinct kinds. Filter logic + render branch handles them.
  const CHANNEL_EVENT_KINDS = new Set([
    "channel_created", "channel_member_added", "channel_member_removed",
    "channel_renamed", "channel_owner_transferred", "channel_meta_changed",
  ]);
  const filtered = feed.filter(f => {
    if (activeType === "reactions") return f.kind === "reaction";
    if (activeType === "events") return CHANNEL_EVENT_KINDS.has(f.kind);
    if (f.kind === "reaction" && f.parent_signal_id) return false;
    if (activeType === "signals") return f.kind === "signal";
    return true;  // "all"
  });

  return (
    <div className="d-page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("feed.title")}</strong></div>
        <div className="header-actions">
          <div className="filter-chips">
            {["all", "signals", "reactions", "events"].map((f) => (
              <button key={f} className={`filter-chip ${activeType === f ? "active" : ""}`} onClick={() => setActiveType(f)}>
                {t(`feed.${f}`)}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{feed.length} {t("feed.items")}</span>
        </div>
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div className="feed-main">
          {loading && (
            <>
              {[0, 1, 2].map(i => (
                <div className="signal-card-skeleton" key={i}>
                  <div className="skel-head">
                    <div className="skeleton-circle" style={{ width: 28, height: 28 }} />
                    <div className="skeleton-line" style={{ width: 80, height: 12 }} />
                    <div className="skeleton-line" style={{ width: 48, height: 10, marginLeft: "auto" }} />
                  </div>
                  <div className="skel-grid">
                    {[0, 1, 2, 3, 4].map(j => (
                      <div className="skel-cell" key={j}>
                        <div className="skeleton-line" style={{ width: "60%", height: 8, marginBottom: 4 }} />
                        <div className="skeleton-line" style={{ width: "80%", height: 10 }} />
                      </div>
                    ))}
                  </div>
                  <div className="skeleton-line" style={{ width: "100%", height: 24, borderRadius: 4 }} />
                </div>
              ))}
            </>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 24, color: "var(--ink-faint)", fontSize: 12, textAlign: "center" }}>{t("feed.empty")}</div>
          )}
          {filtered.map(item => {
            const p = item.payload ?? {};
            const handle = item.from_username ?? item.from_address?.slice(0, 8) ?? "?";
            const avatar = (item.from_username || "?")[0]!.toUpperCase();
            const channelLabel = item.channel_name ?? item.peer?.username ?? item.channel_id?.slice(0, 8) ?? "";
            const reactions = item.signal_id ? (reactionsMap.get(item.signal_id) ?? []) : [];
            if (item.kind === "signal" && (p.symbol || p.token)) {
              return (
                <div className="signal-group" key={item.signal_id ?? item.created_at}>
                  <SignalCard
                    handle={handle} avatar={avatar} time={formatTime(item.created_at)}
                    channel={channelLabel}
                    isGroup={!!item.is_group}
                    symbol={p.symbol ?? p.token ?? "—"} direction={p.direction === "short" ? "short" : "long"}
                    leverage={p.metadata?.leverage ?? p.leverage ?? "—"}
                    entry={p.metadata?.entry_price ?? p.entry_price ?? p.entry ?? "—"}
                    sltp={`${p.metadata?.stop_loss ?? p.sl ?? "—"} / ${p.metadata?.take_profit ?? p.tp ?? "—"}`}
                    reason={p.reason ?? p.reasoning ?? ""}
                    agrees={reactionCounts.get(item.signal_id!)?.agrees ?? 0}
                    against={reactionCounts.get(item.signal_id!)?.against ?? 0}
                  />
                  {(() => {
                    const sigType = p.type as string | undefined;
                    if (sigType && sigType !== "trade_entry") {
                      return (
                        <div className="signal-action-row">
                          <span className="action-badge exit-notice">{t("feed.exitNotice")}</span>
                          {p.metadata?.exit_reason && <span className="action-note">{p.metadata.exit_reason}</span>}
                          {p.metadata?.pnl_pct != null && (
                            <span className={`action-note ${p.metadata.pnl_pct >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                              {p.metadata.pnl_pct >= 0 ? "+" : ""}{p.metadata.pnl_pct.toFixed(2)}%
                            </span>
                          )}
                        </div>
                      );
                    }
                    // Self-pushed signal: I'm the source, not the consumer.
                    // Surface peer-reaction summary + any decision my own daemon made
                    // on the SAME token in another channel (cross-channel correlation).
                    if (item.from_address === auth.address) {
                      const counts = item.signal_id ? reactionCounts.get(item.signal_id) : undefined;
                      const agrees = counts?.agrees ?? 0;
                      const against = counts?.against ?? 0;
                      const token = (p.token ?? p.symbol) as string | undefined;
                      const sigTs = new Date(item.created_at).getTime();
                      let related: FeedItem | null = null;
                      if (token) {
                        for (const f of feed) {
                          if (f.kind !== "reaction" || f.from_address !== auth.address) continue;
                          if (!f.parent_signal_id || f.parent_signal_id === item.signal_id) continue;
                          const parent = feed.find(s => s.kind === "signal" && s.signal_id === f.parent_signal_id);
                          const parentToken = (parent?.payload?.token ?? parent?.payload?.symbol) as string | undefined;
                          if (parentToken !== token) continue;
                          const dt = Math.abs(new Date(f.created_at).getTime() - sigTs);
                          if (dt > 30 * 60 * 1000) continue;
                          related = f;
                          break;
                        }
                      }
                      const rv = related?.payload?.value;
                      const relStatus = rv === "+1" ? "followed" : rv === "-1" ? "passed" : null;
                      return (
                        <div className="signal-action-row">
                          <span className="action-badge sent">{t("feed.sent")}</span>
                          <span className="action-note">{`${agrees} ${t("feed.followedShort")} / ${against} ${t("feed.passedShort")}`}</span>
                          {relStatus && (
                            <span className={`action-badge ${relStatus}`} title={related?.payload?.note ?? ""}>
                              {t(`feed.daemon${relStatus === "followed" ? "Followed" : "Passed"}`)}
                            </span>
                          )}
                          {related?.payload?.note && <span className="action-note">{related.payload.note}</span>}
                        </div>
                      );
                    }
                    const my = item.signal_id ? myReactions.get(item.signal_id) : null;
                    const mp = my?.payload ?? {};
                    const status = mp.value === "+1" ? "followed" : mp.value === "-1" ? "passed" : "no-action";
                    return (
                      <div className="signal-action-row">
                        <span className={`action-badge ${status}`}>
                          {t(`feed.${status === "followed" ? "followed" : status === "passed" ? "passed" : "noAction"}`)}
                        </span>
                        {my?.is_auto && <span className="action-auto">{t("feed.auto")}</span>}
                        {mp.note && <span className="action-note">{mp.note}</span>}
                      </div>
                    );
                  })()}
                  {reactions.length > 0 && (
                    <div className="signal-reactions">
                      {reactions.map(r => {
                        const rHandle = r.from_username ?? r.from_address?.slice(0, 8) ?? "?";
                        const rAvatar = (r.from_username || "?")[0]!.toUpperCase();
                        const rp = r.payload ?? {};
                        const vote = rp.value === "+1" ? "👍" : rp.value === "-1" ? "👎" : "";
                        return (
                          <div className="reaction-inline" key={r.reaction_id ?? r.created_at}>
                            <div className="signal-avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{rAvatar}</div>
                            <span className="reaction-handle">@{rHandle}</span>
                            {vote && <span className="reaction-vote">{vote}</span>}
                            {rp.note && <span className="reaction-note">{rp.note}</span>}
                            {rp.size_factor != null && <span className="reaction-size">size: {rp.size_factor}</span>}
                            <span className="reaction-ts">{formatTime(r.created_at)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            // Phase 10 D7 + D10 — channel structural event narrative row.
            if (CHANNEL_EVENT_KINDS.has(item.kind)) {
              const ap = item.payload as any;
              const actorName = ap?.actor_username ?? item.from_username ?? "?";
              const targetName = ap?.target_username ?? "?";
              const channelName = item.channel_name ?? item.channel_id?.slice(0, 8) ?? "?";
              const reason = ap?.reason as string | undefined;
              const oldName = ap?.old_name as string | undefined;
              const newName = ap?.new_name as string | undefined;
              let text = "";
              let icon = "·";
              let tone: "info" | "warn" | "destructive" = "info";
              switch (item.kind) {
                case "channel_created":
                  icon = "+"; text = lang === "zh"
                    ? `@${actorName} 创建了群组 ${channelName}`
                    : `@${actorName} created group ${channelName}`; break;
                case "channel_member_added":
                  icon = "→"; text = lang === "zh"
                    ? `@${actorName} 邀请 @${targetName} 加入 ${channelName}`
                    : `@${actorName} invited @${targetName} to ${channelName}`; break;
                case "channel_member_removed":
                  if (reason === "kicked") {
                    icon = "✗"; tone = "destructive"; text = lang === "zh"
                      ? `@${actorName} 把 @${targetName} 踢出 ${channelName}`
                      : `@${actorName} kicked @${targetName} from ${channelName}`;
                  } else {
                    icon = "←"; text = lang === "zh"
                      ? `@${targetName} 离开了 ${channelName}`
                      : `@${targetName} left ${channelName}`;
                  } break;
                case "channel_owner_transferred":
                  icon = "⇌"; text = lang === "zh"
                    ? `${channelName} 群主从 @${actorName} 转给 @${targetName}`
                    : `${channelName} ownership: @${actorName} → @${targetName}`; break;
                case "channel_renamed":
                  icon = "✎"; text = lang === "zh"
                    ? `@${actorName} 把群 "${oldName}" 改名为 "${newName}"`
                    : `@${actorName} renamed "${oldName}" to "${newName}"`; break;
                case "channel_meta_changed":
                  icon = "⚙"; text = lang === "zh"
                    ? `@${actorName} 更新了 ${channelName} 的 meta`
                    : `@${actorName} updated ${channelName} meta`; break;
                default:
                  text = `${item.kind}: ${JSON.stringify(ap).slice(0, 80)}`;
              }
              const toneColor = tone === "destructive" ? "var(--red, #ef4444)" : "var(--ink-faint)";
              return (
                <div key={item.created_at + item.kind + (ap?.target_address ?? "")} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 14px", fontSize: 11,
                  color: toneColor, lineHeight: 1.6,
                  borderLeft: `2px solid ${tone === "destructive" ? "var(--red, #ef4444)" : "var(--border-base, #2a2a2a)"}`,
                  background: "rgba(255,255,255,0.015)",
                  marginBottom: 4, borderRadius: 3,
                }}>
                  <span style={{ flexShrink: 0, opacity: 0.7, fontFamily: "var(--mono, monospace)" }}>{icon}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
                  <span style={{ flexShrink: 0, opacity: 0.5, fontSize: 10 }}>{formatTime(item.created_at)}</span>
                </div>
              );
            }
            // Phase 10 D9 — fallback render: collapsed summary (not raw JSON dump).
            return (
              <div className="signal-card" key={item.signal_id ?? item.reaction_id ?? item.created_at}>
                <div className="signal-card-head">
                  <div className="signal-avatar">{avatar}</div>
                  <div className="signal-meta">
                    <div className="handle">@{handle}</div>
                    <div className="ts">{formatTime(item.created_at)}</div>
                  </div>
                  <div className={`signal-channel-badge${item.is_group ? " channel-badge-group" : ""}`}>
                    {item.is_group && <span style={{ marginRight: 4, opacity: 0.85 }}>⌘</span>}
                    {channelLabel}
                  </div>
                </div>
                <div className="signal-body-text" style={{ fontSize: 12 }}>
                  {typeof p === "object"
                    ? (p.text ?? p.reasoning ?? p.message ?? p.summary ?? `${item.kind} · ${Object.keys(p).length} fields`)
                    : String(p)
                  }
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   FRIENDS PAGE
// ════════════════════════════════════════════════════════
function FriendsPage() {
  const { t, lang } = useLang();
  const auth = useAuth();
  const [tab, setTab] = useState<"friends" | "groups">("friends");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsLoaded, setFriendsLoaded] = useState(false);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [addVal, setAddVal] = useState("");
  const [addFeedback, setAddFeedback] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [addError, setAddError] = useState("");
  const [removingFriend, setRemovingFriend] = useState<string | null>(null);

  // Groups state
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviteVal, setInviteVal] = useState("");
  const [inviteFb, setInviteFb] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [inviteError, setInviteError] = useState("");  // Phase 10 D2 — backend reason透传
  // Phase 10 D3 — rename / transfer inline editors
  const [renameMode, setRenameMode] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [renameFb, setRenameFb] = useState<"idle" | "sending" | "error">("idle");
  const [renameError, setRenameError] = useState("");
  const [transferMode, setTransferMode] = useState(false);
  const [transferVal, setTransferVal] = useState("");
  const [transferFb, setTransferFb] = useState<"idle" | "sending" | "error">("idle");
  const [transferError, setTransferError] = useState("");
  // Phase 10 D4 — inline destructive confirm. Key format: "kind:targetId" e.g.
  // "kick:abc123" / "leave:gid" / "remove:friend_username". First click sets
  // pending; second click within 4s executes. Auto-clear via setTimeout.
  const [pendingDestruct, setPendingDestruct] = useState<string | null>(null);
  const pendingDestructTimer = useRef<number>(0);
  const armDestruct = (key: string) => {
    if (pendingDestructTimer.current) window.clearTimeout(pendingDestructTimer.current);
    setPendingDestruct(key);
    pendingDestructTimer.current = window.setTimeout(() => setPendingDestruct(null), 4000);
  };
  const clearDestruct = () => {
    if (pendingDestructTimer.current) window.clearTimeout(pendingDestructTimer.current);
    setPendingDestruct(null);
  };
  // G review Phase 10 #4 fix — cleanup pending timer on unmount to prevent
  // setState-on-unmounted warnings if user navigates away mid-arm.
  useEffect(() => () => {
    if (pendingDestructTimer.current) window.clearTimeout(pendingDestructTimer.current);
  }, []);

  const reload = useCallback(() => {
    apiFetch<{ friends: Friend[] }>("/friends").then(r => { setFriends(r.friends); setFriendsLoaded(true); if (tab === "friends" && !selected && r.friends.length) setSelected(r.friends[0]!.friend_username ?? r.friends[0]!.friend_address); }).catch(() => { setFriendsLoaded(true); });
    apiFetch<{ requests: FriendRequest[] }>("/friends/requests").then(r => setRequests(r.requests)).catch(() => {});
  }, [selected, tab]);

  const reloadGroups = useCallback(() => {
    apiFetch<{ groups: Group[] }>("/channels/groups").then(r => {
      setGroups(r.groups);
      if (tab === "groups" && !selectedGroup && r.groups.length) setSelectedGroup(r.groups[0]!.channel_id);
    }).catch(() => {});
  }, [selectedGroup, tab]);

  useEffect(() => {
    reload();
    reloadGroups();
    apiFetch<{ events: FeedItem[] }>("/signals/feed?limit=200").then(r => {
      const events = r.events ?? [];
      setFeed(events);
      if (auth.address) {
        const positions = buildPositions(events, auth.address);
        if (positions.length > 0) {
          const symbols = [...new Set(positions.map(p => p.token))].join(",");
          apiFetch<{ prices: Record<string, number> }>(`/prices?symbols=${symbols}`)
            .then(pr => setPrices(pr.prices))
            .catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedGroup) {
      apiFetch<{ members: GroupMember[] }>(`/channels/${selectedGroup}/members`).then(r => setGroupMembers(r.members)).catch(() => setGroupMembers([]));
    }
  }, [selectedGroup]);

  const handleAdd = async (username?: string) => {
    const name = (username ?? addVal).trim().replace(/^@/, "");
    if (!name) return;
    setAddFeedback("sending");
    setAddError("");
    try {
      await apiFetch("/friends/add", { method: "POST", body: JSON.stringify({ username: name }) });
      setAddFeedback("sent");
      setAddVal("");
      reload();
      setTimeout(() => setAddFeedback("idle"), 2000);
    } catch (e: any) {
      setAddFeedback("error");
      setAddError(e?.message ?? "failed");
      setTimeout(() => setAddFeedback("idle"), 3000);
    }
  };

  const handleAccept = async (username: string) => {
    try {
      await apiFetch("/friends/accept", { method: "POST", body: JSON.stringify({ username }) });
      reload();
    } catch {}
  };

  const handleCreateGroup = async () => {
    setCreating(true);
    try {
      const r = await apiFetch<{ channel_id: string }>("/channels", { method: "POST", body: JSON.stringify({ name: createName.trim() || undefined }) });
      setCreateName("");
      reloadGroups();
      setSelectedGroup(r.channel_id);
    } catch {}
    setCreating(false);
  };

  const handleInvite = async () => {
    if (!selectedGroup || !inviteVal.trim()) return;
    setInviteFb("sending");
    setInviteError("");
    try {
      await apiFetch(`/channels/${selectedGroup}/invite`, { method: "POST", body: JSON.stringify({ username: inviteVal.trim().replace(/^@/, "") }) });
      setInviteFb("sent");
      setInviteVal("");
      apiFetch<{ members: GroupMember[] }>(`/channels/${selectedGroup}/members`).then(r => setGroupMembers(r.members)).catch(() => {});
      reloadGroups();
      setTimeout(() => setInviteFb("idle"), 2000);
    } catch (e: any) {
      // Phase 10 D2 — preserve backend reason for agent decision + user clarity.
      // Backend returns one of: user_not_found / address is banned from this channel /
      // channel is full / already a member / invalid_address / rate_limited / not member
      setInviteFb("error");
      setInviteError(e?.message ?? "invite failed");
      setTimeout(() => { setInviteFb("idle"); setInviteError(""); }, 4000);
    }
  };

  const handleLeave = async (channelId: string) => {
    try {
      await apiFetch(`/channels/${channelId}/leave`, { method: "POST" });
      setSelectedGroup(null);
      clearDestruct();
      reloadGroups();
    } catch {}
  };

  const handleKick = async (channelId: string, addr: string, username: string | null) => {
    try {
      await apiFetch(`/channels/${channelId}/kick`, { method: "POST", body: JSON.stringify({ address: addr }) });
      clearDestruct();
      apiFetch<{ members: GroupMember[] }>(`/channels/${channelId}/members`).then(r => setGroupMembers(r.members)).catch(() => {});
      reloadGroups();
    } catch {}
    void username; // keep param signature for inline call site clarity
  };

  // Phase 10 D3 — rename group (owner only)
  const handleRename = async () => {
    if (!selectedGroup || !renameVal.trim()) return;
    setRenameFb("sending");
    setRenameError("");
    try {
      await apiFetch(`/channels/${selectedGroup}/rename`, { method: "POST", body: JSON.stringify({ name: renameVal.trim().slice(0, 80) }) });
      setRenameVal("");
      setRenameMode(false);
      setRenameFb("idle");
      reloadGroups();
    } catch (e: any) {
      setRenameFb("error");
      setRenameError(e?.message ?? "rename failed");
      setTimeout(() => { setRenameFb("idle"); setRenameError(""); }, 4000);
    }
  };

  // Phase 10 D3 — transfer ownership (owner only)
  const handleTransfer = async () => {
    if (!selectedGroup || !transferVal.trim()) return;
    setTransferFb("sending");
    setTransferError("");
    try {
      await apiFetch(`/channels/${selectedGroup}/transfer-owner`, {
        method: "POST",
        body: JSON.stringify({ username: transferVal.trim().replace(/^@/, "") }),
      });
      setTransferVal("");
      setTransferMode(false);
      setTransferFb("idle");
      reloadGroups();
    } catch (e: any) {
      setTransferFb("error");
      setTransferError(e?.message ?? "transfer failed");
      setTimeout(() => { setTransferFb("idle"); setTransferError(""); }, 4000);
    }
  };

  const selectedFriend = friends.find(f => (f.friend_username ?? f.friend_address) === selected);
  const activeGroup = groups.find(g => g.channel_id === selectedGroup);

  return (
    <div className="d-page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="d-page-header" style={{ flexShrink: 0 }}>
        <div className="d-page-title">susurration / <strong>{t("friends.title")}</strong></div>
      </div>
      {/* Tab switcher */}
      <div style={{ display: "flex", gap: 0, borderBottom: "0.5px solid var(--border-base)", flexShrink: 0, padding: "0 16px" }}>
        <button onClick={() => setTab("friends")} style={{ background: "none", border: "none", borderBottom: tab === "friends" ? "1.5px solid var(--ink)" : "1.5px solid transparent", padding: "8px 16px", fontSize: 12, fontFamily: "var(--mono)", color: tab === "friends" ? "var(--ink)" : "var(--ink-faint)", cursor: "pointer", letterSpacing: "0.3px" }}>
          {t("friends.friendsLabel")} ({friends.length})
        </button>
        <button onClick={() => setTab("groups")} style={{ background: "none", border: "none", borderBottom: tab === "groups" ? "1.5px solid var(--ink)" : "1.5px solid transparent", padding: "8px 16px", fontSize: 12, fontFamily: "var(--mono)", color: tab === "groups" ? "var(--ink)" : "var(--ink-faint)", cursor: "pointer", letterSpacing: "0.3px" }}>
          {t("groups.label")} ({groups.length})
        </button>
      </div>
      {tab === "friends" && (
        <div className="page-inner-flex" style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="friends-list-col">
            <div className="friends-list-header">
              <div className="add-friend-row">
                <span className="add-friend-prefix">@</span>
                <input className="add-friend-input" type="text" placeholder={t("friends.addPlaceholder")} value={addVal} onChange={(e) => setAddVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} />
                <button className="add-btn" onClick={() => handleAdd()} disabled={addFeedback === "sending"} style={addFeedback === "sent" ? { color: "var(--green)" } : addFeedback === "error" ? { color: "var(--red)" } : undefined}>
                  {addFeedback === "sending" ? "…" : addFeedback === "sent" ? t("friends.sent") : addFeedback === "error" ? addError.slice(0, 20) : t("friends.add")}
                </button>
              </div>
              {friendsLoaded && !friends.some(f => f.friend_username === "demo") && (
                <>
                  <div className="friends-section-label" style={{ marginBottom: 6 }}>{t("friends.recommended")}</div>
                  <div className="rec-friend-card">
                    <div className="friend-avatar" style={{ color: "var(--green)" }}>D</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--ink)" }}>@demo</div>
                      <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2, lineHeight: 1.4 }}>{t("friends.recDesc")}</div>
                    </div>
                    <button className="add-btn" onClick={() => handleAdd("demo")} style={{ flexShrink: 0 }}>{t("friends.add")}</button>
                  </div>
                </>
              )}
              {requests.length > 0 && (
                <>
                  <div className="friends-section-label" style={{ marginBottom: 6 }}>{t("friends.pending")} ({requests.length})</div>
                  <div className="pending-list">
                    {requests.map(r => (
                      <div className="pending-item" key={r.request_id}>
                        <span className="p-handle">@{r.from_username ?? r.from_addr.slice(0, 8)}</span>
                        <div className="p-actions">
                          <button className="p-acc" onClick={() => handleAccept(r.from_username ?? r.from_addr)}>{t("friends.accept")}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="friends-list-scroll">
              {friends.length === 0 && (
                <div style={{ padding: "24px 16px", fontSize: 12, color: "var(--ink-faint)", textAlign: "center" }}>{t("friends.noFriends")}</div>
              )}
              {friends.map((f) => {
                const handle = f.friend_username ?? f.friend_address.slice(0, 8);
                const avatar = (f.friend_username || f.friend_address)[0]!.toUpperCase();
                return (
                  <div key={f.friend_address} className={`friend-item ${selected === handle ? "selected" : ""}`} onClick={() => setSelected(handle)}>
                    <div className="friend-avatar">{avatar}</div>
                    <div className="friend-info">
                      <div className="friend-handle">@{handle}</div>
                      <div className="friend-last">{timeAgo(f.created_at, lang)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {selectedFriend && (() => {
            const friendHandle = selectedFriend.friend_username ?? selectedFriend.friend_address.slice(0, 8);
            const d30 = Date.now() - 30 * 86400000;
            const friendSignals = feed.filter(f => f.kind === "signal" && (f.from_username === friendHandle) && new Date(f.created_at).getTime() > d30);
            const friendSignalIds = new Set(friendSignals.map(f => f.signal_id).filter(Boolean));
            const myReactions = feed.filter(f => f.kind === "reaction" && f.from_address === auth.address && f.parent_signal_id != null && friendSignalIds.has(f.parent_signal_id));
            const acceptCount = myReactions.filter(r => r.payload?.value === "+1").length;
            const acceptRate = friendSignals.length > 0 ? Math.round((acceptCount / friendSignals.length) * 100) : 0;

            const rawPositions = auth.address ? buildPositions(feed.filter(f => (f.kind === "signal" && f.from_username === friendHandle) || (f.kind === "reaction" && f.from_address === auth.address)), auth.address) : [];
            const friendPositionsResult = Object.keys(prices).length > 0 ? applyPrices(rawPositions, prices, new Map()) : { positions: rawPositions };
            const friendPositions = friendPositionsResult.positions;
            const friendPnl = friendPositions.reduce((s: number, p: Position) => s + (p.pnlUsd ?? 0), 0);

            return (
              <div className="friends-detail-col">
                <div className="friend-profile-card">
                  <div className="friend-profile-top">
                    <div className="friend-avatar-lg">{(selectedFriend.friend_username || selectedFriend.friend_address)[0]!.toUpperCase()}</div>
                    <div>
                      <div className="friend-name">@{friendHandle}</div>
                      <div className="friend-sub" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {t("friends.addedOn")} {new Date(selectedFriend.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <div className="friend-stats-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12 }}>
                    <div className="friend-stat-cell" style={{ textAlign: "center", borderRight: "0.5px solid var(--border-base)" }}>
                      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>{friendSignals.length}</div>
                      <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{t("friends.30dSignals")}</div>
                    </div>
                    <div className="friend-stat-cell" style={{ textAlign: "center", borderRight: "0.5px solid var(--border-base)" }}>
                      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>{acceptRate}%</div>
                      <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{t("friends.acceptRate")}</div>
                    </div>
                    <div className="friend-stat-cell" style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 16, fontWeight: 600, color: friendPnl > 0 ? "var(--green)" : friendPnl < 0 ? "var(--red)" : "var(--ink-faint)" }}>
                        {friendPnl !== 0 ? `${friendPnl > 0 ? "+" : ""}$${Math.abs(friendPnl).toFixed(2)}` : "—"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{t("friends.pnl")}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12, textAlign: "center" }}>
                    {(() => {
                      const removeKey = `remove:${friendHandle}`;
                      const isPending = pendingDestruct === removeKey;
                      const isLoading = removingFriend === friendHandle;
                      return (
                        <button
                          style={{
                            fontSize: 11,
                            color: isPending ? "#fff" : "var(--red)",
                            background: isPending ? "var(--red)" : "none",
                            border: "0.5px solid var(--red)",
                            padding: "4px 14px", cursor: "pointer", borderRadius: 3, fontFamily: "var(--mono)", letterSpacing: "0.3px",
                          }}
                          disabled={isLoading}
                          onClick={() => {
                            if (!isPending) { armDestruct(removeKey); return; }
                            setRemovingFriend(friendHandle);
                            clearDestruct();
                            apiFetch("/friends/remove", { method: "POST", body: JSON.stringify({ username: friendHandle }) })
                              .then(() => { setSelected(null); reload(); })
                              .catch(() => {})
                              .finally(() => setRemovingFriend(null));
                          }}
                        >
                          {isLoading ? "…" : isPending ? (lang === "zh" ? "确认删除" : "Confirm remove") : (lang === "zh" ? "删除好友" : "Remove")}
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
      {tab === "groups" && (
        <div className="page-inner-flex" style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div className="friends-list-col">
            <div className="friends-list-header">
              {/* Phase 10 D1 — lead 段：解释群组 vs 好友。Susurration north star 是 agent
                  协作网络，群组是 multi-agent 共享 context；空说明 = 用户不懂为何用群。 */}
              <div style={{ fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.7, padding: "6px 2px 12px", borderBottom: "0.5px solid var(--border-base)", marginBottom: 12 }}>
                {lang === "zh"
                  ? <>⌘ <strong style={{ color: "var(--ink-soft)" }}>群组</strong> — 让多个 agent 在共享 context 协作。这里推送的信号所有成员都能看到，反应也对所有人可见。</>
                  : <>⌘ <strong style={{ color: "var(--ink-soft)" }}>Groups</strong> — multiple agents collaborating in shared context. Signals you push here reach all members; reactions are visible to everyone.</>
                }
              </div>
              <div className="add-friend-row">
                <input className="add-friend-input" type="text" placeholder={lang === "zh" ? "群名（可选，例如 btc-scalp）" : "group name (optional, e.g. btc-scalp)"} value={createName} onChange={(e) => setCreateName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()} style={{ paddingLeft: 10 }} />
                <button className="add-btn" onClick={handleCreateGroup} disabled={creating || groups.length >= 5}>
                  {creating ? t("groups.creating") : t("groups.create")}
                </button>
              </div>
              {/* Phase 10 D6 — capacity counter (max 5 per address per backend MAX_CHANNELS_PER_ADDRESS) */}
              <div style={{ fontSize: 10, color: groups.length >= 4 ? "var(--yellow, #f59e0b)" : "var(--ink-faint)", marginTop: 6, paddingLeft: 2 }}>
                {groups.length}/5 {lang === "zh" ? "个群（owner 上限 5）" : "groups (owner limit 5)"}
              </div>
            </div>
            <div className="friends-list-scroll">
              {groups.length === 0 && (
                <div style={{ padding: "24px 16px", fontSize: 12, color: "var(--ink-faint)", textAlign: "center" }}>{t("groups.noGroups")}</div>
              )}
              {groups.map((g) => {
                const name = g.name || t("groups.unnamed");
                const avatar = (g.name || g.channel_id)[0]!.toUpperCase();
                return (
                  <div key={g.channel_id} className={`friend-item ${selectedGroup === g.channel_id ? "selected" : ""}`} onClick={() => setSelectedGroup(g.channel_id)}>
                    {/* Phase 10 D5 — square avatar + ⌘ icon to distinguish from round friend avatars */}
                    {/* Phase 12 H #5 — group=6px rounded square (vs friends round); Linear/Slack convention */}
                    <div className="friend-avatar" style={{ borderRadius: 6, position: "relative" }}>
                      {avatar}
                      <span style={{ position: "absolute", bottom: -2, right: -2, fontSize: 8, background: "var(--surface)", borderRadius: "50%", width: 12, height: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-soft)" }}>⌘</span>
                    </div>
                    <div className="friend-info">
                      <div className="friend-handle" style={!g.name ? { color: "var(--ink-faint)", fontStyle: "italic" } : undefined}>{name}</div>
                      <div className="friend-last">{g.member_count} {g.member_count === 1 ? t("groups.member") : t("groups.members")}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {activeGroup && (() => {
            const iAmOwner = activeGroup.owner === auth.address;
            const leaveKey = `leave:${activeGroup.channel_id}`;
            return (
            <div className="friends-detail-col">
              <div className="friend-profile-card">
                <div className="friend-profile-top">
                  {/* Phase 12 H #5 — group large avatar matches list (6px square) */}
                  <div className="friend-avatar-lg" style={{ borderRadius: 6 }}>{(activeGroup.name || activeGroup.channel_id)[0]!.toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {!renameMode ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div className="friend-name" style={!activeGroup.name ? { color: "var(--ink-faint)", fontStyle: "italic" } : undefined}>{activeGroup.name || t("groups.unnamed")}</div>
                        {iAmOwner && (
                          <button
                            onClick={() => { setRenameMode(true); setRenameVal(activeGroup.name ?? ""); }}
                            style={{ fontSize: 10, color: "var(--ink-faint)", background: "none", border: "0.5px solid var(--border2)", padding: "1px 6px", cursor: "pointer", borderRadius: 3, fontFamily: "var(--mono)" }}
                            title={lang === "zh" ? "改名" : "rename"}
                          >
                            ✎
                          </button>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="text" value={renameVal} maxLength={80}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") { setRenameMode(false); setRenameError(""); } }}
                          style={{ flex: 1, background: "var(--surface)", border: "0.5px solid var(--border-base)", borderRadius: 4, padding: "3px 8px", fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)", outline: "none" }}
                          autoFocus
                        />
                        <button onClick={handleRename} disabled={renameFb === "sending"} style={{ fontSize: 11, color: "var(--green)", background: "none", border: "0.5px solid var(--border2)", padding: "2px 8px", cursor: "pointer", borderRadius: 3 }}>{renameFb === "sending" ? "…" : "✓"}</button>
                        <button onClick={() => { setRenameMode(false); setRenameError(""); }} style={{ fontSize: 11, color: "var(--ink-faint)", background: "none", border: "0.5px solid var(--border2)", padding: "2px 8px", cursor: "pointer", borderRadius: 3 }}>✗</button>
                      </div>
                    )}
                    {renameError && <div style={{ fontSize: 10, color: "var(--red)", marginTop: 4 }}>{renameError}</div>}
                    <div className="friend-sub">{activeGroup.member_count} {activeGroup.member_count === 1 ? t("groups.member") : t("groups.members")} · {new Date(activeGroup.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
                {/* Invite row */}
                {iAmOwner ? (
                  <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <span style={{ color: "var(--ink-faint)", fontSize: 12, lineHeight: "28px" }}>@</span>
                      <input type="text" placeholder={t("groups.invitePlaceholder")} value={inviteVal} onChange={(e) => setInviteVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleInvite()} style={{ flex: 1, background: "var(--surface)", border: "0.5px solid var(--border-base)", borderRadius: 6, padding: "4px 8px", fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)", outline: "none" }} />
                      <button className="add-btn" onClick={handleInvite} disabled={inviteFb === "sending"} style={inviteFb === "sent" ? { color: "var(--green)" } : inviteFb === "error" ? { color: "var(--red)" } : undefined}>
                        {inviteFb === "sending" ? t("groups.inviting") : inviteFb === "sent" ? t("groups.invited") : t("groups.invite")}
                      </button>
                    </div>
                    {/* Phase 10 D2 — show backend error reason inline (not just red flash) */}
                    {inviteError && (
                      <div style={{ fontSize: 10, color: "var(--red)", marginTop: 6, lineHeight: 1.5 }}>{inviteError}</div>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 10, fontSize: 11, color: "var(--ink-faint)", fontStyle: "italic" }}>
                    {t("groups.ownerCanInvite")}
                  </div>
                )}
                {/* Members list */}
                <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12 }}>
                  {groupMembers.map(m => {
                    const handle = m.username ?? m.address.slice(0, 8);
                    const isOwner = m.address === activeGroup.owner;
                    const isMe = m.address === auth.address;
                    const kickKey = `kick:${activeGroup.channel_id}:${m.address}`;
                    const kickPending = pendingDestruct === kickKey;
                    return (
                      <div key={m.address} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "0.5px solid var(--border-base)" }}>
                        <div className="friend-avatar" style={{ width: 24, height: 24, fontSize: 10, lineHeight: "24px" }}>{(m.username || m.address)[0]!.toUpperCase()}</div>
                        <div style={{ flex: 1, fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)" }}>
                          @{handle}
                          {isOwner && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-faint)" }}>({t("groups.owner")})</span>}
                          {isMe && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-faint)" }}>({t("groups.you")})</span>}
                        </div>
                        {iAmOwner && !isMe && (
                          /* Phase 10 D4 — inline 2-step confirm replaces native confirm() */
                          <button
                            onClick={() => kickPending ? handleKick(activeGroup.channel_id, m.address, m.username) : armDestruct(kickKey)}
                            style={{
                              fontSize: 11, color: kickPending ? "#fff" : "var(--red)",
                              background: kickPending ? "var(--red)" : "none",
                              border: "0.5px solid var(--red)", padding: "2px 8px",
                              cursor: "pointer", borderRadius: 4, fontFamily: "var(--mono)", letterSpacing: "0.3px",
                            }}
                          >
                            {kickPending ? (lang === "zh" ? `确认踢出` : `Confirm kick`) : t("groups.kick")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Phase 10 D3 — owner-only transfer ownership inline */}
                {iAmOwner && (
                  <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12 }}>
                    {!transferMode ? (
                      <button
                        onClick={() => setTransferMode(true)}
                        style={{ fontSize: 11, color: "var(--ink-soft)", background: "none", border: "0.5px solid var(--border2)", padding: "4px 12px", cursor: "pointer", borderRadius: 4, fontFamily: "var(--mono)", letterSpacing: "0.3px" }}
                      >
                        {lang === "zh" ? "转让群主" : "Transfer ownership"}
                      </button>
                    ) : (
                      <div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>@</span>
                          <input
                            type="text" placeholder={lang === "zh" ? "新群主用户名" : "new owner username"}
                            value={transferVal} onChange={(e) => setTransferVal(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleTransfer(); if (e.key === "Escape") { setTransferMode(false); setTransferError(""); } }}
                            style={{ flex: 1, background: "var(--surface)", border: "0.5px solid var(--border-base)", borderRadius: 4, padding: "3px 8px", fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)", outline: "none" }}
                            autoFocus
                          />
                          <button onClick={handleTransfer} disabled={transferFb === "sending"} style={{ fontSize: 11, color: "var(--green)", background: "none", border: "0.5px solid var(--border2)", padding: "2px 8px", cursor: "pointer", borderRadius: 3 }}>{transferFb === "sending" ? "…" : "✓"}</button>
                          <button onClick={() => { setTransferMode(false); setTransferError(""); }} style={{ fontSize: 11, color: "var(--ink-faint)", background: "none", border: "0.5px solid var(--border2)", padding: "2px 8px", cursor: "pointer", borderRadius: 3 }}>✗</button>
                        </div>
                        {transferError && <div style={{ fontSize: 10, color: "var(--red)", marginTop: 4 }}>{transferError}</div>}
                        <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}>
                          {lang === "zh" ? "新群主必须已是当前成员。转让后你失去 owner 权限。" : "New owner must already be a member. You'll lose owner rights after transfer."}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Leave button — Phase 10 D4 inline 2-step confirm */}
                <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12, textAlign: "center" }}>
                  <button
                    onClick={() => pendingDestruct === leaveKey ? handleLeave(activeGroup.channel_id) : armDestruct(leaveKey)}
                    style={{
                      fontSize: 11,
                      color: pendingDestruct === leaveKey ? "#fff" : "var(--red)",
                      background: pendingDestruct === leaveKey ? "var(--red)" : "none",
                      border: "0.5px solid var(--red)", padding: "4px 14px",
                      cursor: "pointer", borderRadius: 4, fontFamily: "var(--mono)", letterSpacing: "0.3px",
                    }}
                  >
                    {pendingDestruct === leaveKey ? (lang === "zh" ? "确认退出群组" : "Confirm leave") : t("groups.leave")}
                  </button>
                </div>
              </div>
            </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   SETTINGS PAGE
// ════════════════════════════════════════════════════════
function SettingsPage({ onShowOnboarding }: { onShowOnboarding: () => void }) {
  const { t } = useLang();
  const auth = useAuth();
  const [whoami, setWhoami] = useState<any>(null);
  const [allowance, setAllowance] = useState<any>(null);
  const [disconnectState, setDisconnectState] = useState<"idle" | "ing" | "done">("idle");

  useEffect(() => {
    apiFetch("/identity/whoami").then(setWhoami).catch(() => {});
    apiFetch("/billing/allowance").then(setAllowance).catch(() => {});
  }, []);

  const addrShort = auth.address ? `${auth.address.slice(0, 4)}…${auth.address.slice(-4)}` : "—";

  return (
    <div className="d-page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("settings.title")}</strong></div>
      </div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-title">{t("settings.identity")}</div>
          <div className="settings-row">
            <div className="settings-row-left"><div className="settings-row-key">{t("settings.handle")}</div><div className="settings-row-val">@{whoami?.username ?? auth.username ?? "—"}</div></div>
            <div className="settings-row-right"><span className="settings-locked">{t("settings.permanent")}</span></div>
          </div>
          <div className="settings-row">
            <div className="settings-row-left"><div className="settings-row-key">{t("settings.solanaAddr")}</div><div className="settings-row-val">{addrShort}</div></div>
            <div className="settings-row-right"><CopyBtn text={auth.address ?? ""} /></div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">{t("settings.agentConn")}</div>
          <div className="settings-row">
            <div className="settings-row-left">
              <div className="settings-row-key">MCP Adapter</div>
              <div className="settings-row-val">{(() => {
                if (!whoami?.last_mcp_ping_at) return <span style={{ color: "var(--ink-faint)" }}>never connected</span>;
                return <span style={{ color: "var(--green)" }}>ok · {timeAgo(whoami.last_mcp_ping_at)}</span>;
              })()}</div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-left"><div className="settings-row-key">{t("settings.reconnect")}</div></div>
            <div className="settings-row-right"><button className="d-btn d-btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={onShowOnboarding}>{t("settings.reconfigure")}</button></div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">{t("settings.billing")}</div>
          <div className="settings-row">
            <div className="settings-row-left">
              <div className="settings-row-key">{t("settings.balance")}</div>
              <div className="settings-row-val">
                {allowance?.free_credits_usd != null
                  ? `$${Number(allowance.free_credits_usd).toFixed(2)} ${t("dash.freeCredits")}`
                  : "—"}
              </div>
            </div>
          </div>
        </div>
        <ModeDocSection />
        <div className="settings-section">
          <div className="settings-section-title">{t("settings.danger")}</div>
          <div className="settings-row">
            <div className="settings-row-left"><div className="settings-row-key">{t("settings.disconnect")}</div><div className="settings-row-val">{t("settings.disconnectSub")}</div></div>
            <div className="settings-row-right">
              <button
                className="d-btn d-btn-danger"
                style={{ fontSize: 11, padding: "5px 12px" }}
                disabled={disconnectState !== "idle"}
                onClick={() => {
                  setDisconnectState("ing");
                  localStorage.removeItem("susu_token");
                  localStorage.removeItem("susu_address");
                  localStorage.removeItem("susu_handle");
                  setTimeout(() => { setDisconnectState("done"); window.location.reload(); }, 800);
                }}
              >
                {disconnectState === "idle" ? t("settings.disconnectBtn") : disconnectState === "ing" ? t("settings.disconnecting") : t("settings.disconnected")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   MODE PAGE — execution mode configuration
// ════════════════════════════════════════════════════════
function CollapsibleSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span style={{ fontSize: 10, color: "var(--ink-faint)", transition: "transform .15s", transform: open ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
      </div>
      {open && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

function ModePage() {
  const { t } = useLang();
  return (
    <div className="d-page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("mode.title")}</strong></div>
      </div>
      <div className="settings-body">
        <div className="mode-status-card" style={{ padding: "24px 28px", background: "var(--surface)", border: "0.5px solid var(--border-base)", borderRadius: 8, marginBottom: 24 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)", marginBottom: 8, display: "block" }}>{t("mode.currentTitle")}</span>
          <p style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.7, margin: 0 }}>
            {t("mode.currentDesc")}
          </p>
        </div>

        <CollapsibleSection title={t("mode.howItWorksTitle")} defaultOpen>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.8 }}>
            <p style={{ margin: "0 0 12px" }}>{t("mode.howItWorks1")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 4 }}>
              {(["mode.howBullet1", "mode.howBullet2", "mode.howBullet3", "mode.howBullet4"] as string[]).map((k) => (
                <div key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>·</span>
                  <span>{t(k)}</span>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t("mode.configTitle")}>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.8 }}>
            <p style={{ margin: "0 0 16px" }}>{t("mode.configIntro")}</p>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, letterSpacing: "0.5px", color: "var(--ink)", marginBottom: 8 }}>{t("mode.step1Title")}</div>
              <p style={{ margin: "0 0 8px" }}>{t("mode.step1Desc")}</p>
              <div className="d-code-block">
                <div className="d-code-block-label">
                  <span>{t("mode.step1Label")}</span>
                  <CopyBtn text='{\n  "execution": {\n    "enabled": true,\n    "provider": "hyperliquid",\n    "api_key": "your-api-key",\n    "api_secret": "your-api-secret"\n  }\n}' />
                </div>
                <pre>
                  <span className="tok-punct">{"{"}</span>{"\n  "}
                  <span className="tok-key">"execution"</span><span className="tok-punct">{": {"}</span>{"\n    "}
                  <span className="tok-key">"enabled"</span><span className="tok-punct">:</span>{" "}<span className="tok-bool">true</span><span className="tok-punct">,</span>{"\n    "}
                  <span className="tok-key">"provider"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"hyperliquid"</span><span className="tok-punct">,</span>{"\n    "}
                  <span className="tok-key">"api_key"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"your-api-key"</span><span className="tok-punct">,</span>{"\n    "}
                  <span className="tok-key">"api_secret"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"your-api-secret"</span>{"\n  "}
                  <span className="tok-punct">{"}"}</span>{"\n"}
                  <span className="tok-punct">{"}"}</span>
                </pre>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, letterSpacing: "0.5px", color: "var(--ink)", marginBottom: 8 }}>{t("mode.step2Title")}</div>
              <p style={{ margin: "0 0 8px" }}>{t("mode.step2Desc")}</p>
              <div className="d-code-block">
                <div className="d-code-block-label"><span>{t("mode.step2Label")}</span></div>
                <pre>
                  <span className="tok-cmd">susu</span>{" "}<span className="tok-arg">config</span>{" "}<span className="tok-arg">set</span>{" "}<span className="tok-str">execution.enabled</span>{" "}<span className="tok-bool">true</span>
                </pre>
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, letterSpacing: "0.5px", color: "var(--ink)", marginBottom: 8 }}>{t("mode.step3Title")}</div>
              <p style={{ margin: 0 }}>{t("mode.step3Desc")}</p>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t("mode.tipsTitle")}>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.8 }}>
            <p style={{ margin: "0 0 12px" }}>{t("mode.tipsIntro")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(["mode.tipItem1", "mode.tipItem2", "mode.tipItem3", "mode.tipItem4"] as string[]).map((k) => (
                <div key={k} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>·</span>
                  <span>{t(k)}</span>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}

function ModeDocSection() {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    navigator.clipboard?.writeText(AGENT_DOC).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{t("doc.title")}</span>
        <button
          className={`d-copy-btn ${copied ? "copied" : ""}`}
          onClick={copyAll}
          style={{ fontSize: 11, padding: "5px 12px" }}
        >
          {copied ? t("copied") : t("doc.copyAll")}
        </button>
      </div>
      <div className="settings-section-body">
        <p style={{ fontSize: 12, color: "var(--ink-faint)", lineHeight: 1.7, marginBottom: 12 }}>
          {t("doc.desc")}
        </p>
        <div className="doc-pre-wrap">
          <pre className="doc-pre">{AGENT_DOC}</pre>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   MAIN DASHBOARD LAYOUT
// ════════════════════════════════════════════════════════
export function DashboardPage() {
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem("susu_token"));
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("susu_page") as Page | null;
    return saved && ["dashboard", "feed", "friends", "mode", "settings"].includes(saved) ? saved : "dashboard";
  });
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const setPagePersist = useCallback((p: Page) => {
    localStorage.setItem("susu_page", p);
    if (p === "feed") { setHasNewActivity(false); localStorage.setItem("susu_feed_seen_at", Date.now().toString()); }
    setPage(p);
  }, []);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([page]));
  useEffect(() => { setVisited(v => v.has(page) ? v : new Set(v).add(page)); }, [page]);
  useEffect(() => { if (!localStorage.getItem("susu_feed_seen_at")) localStorage.setItem("susu_feed_seen_at", Date.now().toString()); }, []);

  const authCtx: AuthCtx = {
    token: localStorage.getItem("susu_token"),
    username: localStorage.getItem("susu_handle"),
    address: localStorage.getItem("susu_address"),
  };

  return (
    <AuthContext.Provider value={authCtx}>
      <NavContext.Provider value={setPagePersist}>
        <ActivityBadgeContext.Provider value={{ setHasNew: setHasNewActivity }}>
        <div className="dash-shell">
          {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}
          {!showOnboarding && <UpgradeBanner />}
          <Sidebar page={page} setPage={setPagePersist} hasNewActivity={hasNewActivity} />
          <div className="dash-content">
            {visited.has("dashboard") && <div style={{ display: page === "dashboard" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}><DashHome /></div>}
            {visited.has("feed") && <div style={{ display: page === "feed" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}><FeedPage /></div>}
            {visited.has("friends") && <div style={{ display: page === "friends" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}><FriendsPage /></div>}
            {visited.has("mode") && <div style={{ display: page === "mode" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}><ModePage /></div>}
            {visited.has("settings") && <div style={{ display: page === "settings" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}><SettingsPage onShowOnboarding={() => setShowOnboarding(true)} /></div>}
            <StatusBar />
          </div>
        </div>
        </ActivityBadgeContext.Provider>
      </NavContext.Provider>
    </AuthContext.Provider>
  );
}
