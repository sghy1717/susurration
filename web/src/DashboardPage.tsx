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
    const sizeFactor = typeof f.payload?.size_factor === "number" ? f.payload.size_factor : 0.7;
    const positionUsd = 100 * 0.3 * sizeFactor;

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
      positionUsd,
    });
  }
  return positions;
}

const TIME_STOP_MS = 48 * 60 * 60 * 1000; // 48h
const TRAILING_STOP_THRESHOLD = 5; // activate after 5% profit
const TRAILING_STOP_RETRACE = 0.5; // close when retraced 50% from peak
const peakPnlMap = new Map<string, number>(); // signalId → highest pnlPct seen

function applyPrices(positions: Position[], prices: Record<string, number>): Position[] {
  return positions.map(pos => {
    const cp = prices[pos.token];
    if (cp === undefined) return pos;

    const isShort = pos.direction === "short";
    const pnlPct = isShort
      ? ((pos.entryPrice - cp) / pos.entryPrice) * 100 * pos.leverage
      : ((cp - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage;
    const pnlUsd = (pnlPct / 100) * pos.positionUsd;

    // Time stop: close at market after 48h
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

    // Trailing stop: track peak PnL, close if retraced 50% from peak after threshold
    const prevPeak = peakPnlMap.get(pos.signalId) ?? 0;
    const newPeak = Math.max(prevPeak, pnlPct);
    peakPnlMap.set(pos.signalId, newPeak);
    if (newPeak > TRAILING_STOP_THRESHOLD && pnlPct < newPeak * TRAILING_STOP_RETRACE) {
      peakPnlMap.delete(pos.signalId);
      return { ...pos, currentPrice: cp, pnlPct, pnlUsd, status: "closed" as const, exitReason: "TRAIL", exitPrice: cp };
    }

    return { ...pos, currentPrice: cp, pnlPct, pnlUsd, status: "open" as const };
  });
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

// ── Signal card (shared between dashboard + feed) ──
function SignalCard({ handle, avatar, avatarColor, time, channel, symbol, direction, leverage, entry, sltp, reason, agrees, against, skips, compact, expired }: {
  handle: string; avatar: string; avatarColor?: string; time: string; channel: string;
  symbol: string; direction: "long" | "short"; leverage: string; entry: string; sltp: string;
  reason: string; agrees: number; against: number; skips?: number; compact?: boolean; expired?: boolean;
}) {
  const { t } = useLang();
  const dirLabel = direction === "long" ? "LONG" : "SHORT";
  return (
    <div className={`signal-card${expired ? " signal-expired" : ""}`}>
      <div className="signal-card-head">
        <div className="signal-avatar" style={avatarColor ? { color: avatarColor } : undefined}>{avatar}</div>
        <div className="signal-meta">
          <div className="handle">@{handle}</div>
          <div className="ts">{time}</div>
        </div>
        {expired && <div className="signal-missed-badge">{t("sig.missed")}</div>}
        <div className="signal-channel-badge">{channel}</div>
      </div>
      <div className="signal-grid">
        <div className="sig-cell"><div className="sig-cell-label">{compact ? t("sig.symbol") : t("sig.symbol")}</div><div className="sig-cell-val">{symbol}</div></div>
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

  const testConnection = () => {
    setConnState("testing");
    setShowSkip(false);
    setSkipped(false);
    const tk = localStorage.getItem("susu_token");
    if (!tk) { setConnState("fail"); setShowSkip(true); return; }
    fetch(`${API}/identity/whoami`, { headers: { Authorization: `Bearer ${tk}` } })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((me: any) => {
        if (me.last_mcp_ping_at) {
          const ago = Date.now() - new Date(me.last_mcp_ping_at).getTime();
          if (ago < 5 * 60 * 1000) { setConnState("success"); return; }
        }
        setConnState("fail");
        setShowSkip(true);
      })
      .catch(() => { setConnState("fail"); setShowSkip(true); });
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

        {/* Step 3: Connect Agent */}
        <div className={`onboard-step ${step === 3 ? "visible" : ""}`}>
          <div className="step-label">{t("ob.step3of3")}</div>
          <div className="step-title">{t("ob.step3.title")}</div>
          <div className="step-sub">{t("ob.step3.sub")}</div>
          <div className="agent-question">{t("ob.step3.question")}</div>
          <div className="ide-selector">
            {AGENTS.map((a) => (
              <button key={a.id} className={`ide-pill ${selectedAgent === a.id ? "active" : ""}`} onClick={() => setSelectedAgent(a.id)}>
                {a.name}
              </button>
            ))}
          </div>

          {/* MCP-based agents */}
          {(["claude", "cursor", "copilot", "windsurf", "codex", "cline"] as AgentId[]).map((aid) => {
            const promptText = `Add the Susurration MCP server to your config, then run susu_join to complete setup.\n\nMCP config JSON:\n${mcpJson(authToken || "sk_live_YOUR_TOKEN")}\n\n⚠️ IMPORTANT: After adding the config, you MUST fully restart your agent (quit and reopen the app — e.g. close the Claude Code terminal and start a new session). The MCP server only loads on startup. Without a restart, connection test will fail.\n\nAfter restart, run:\n  susu_join @${handleVal || "your_handle"} --llm-key YOUR_LLM_API_KEY\n\nTo verify: run susu_whoami — you should see your @handle.`;
            return (
            <div key={aid} className={`agent-setup ${selectedAgent === aid ? "visible" : ""}`}>
              <div className="d-code-block">
                <div className="d-code-block-label">
                  <span>{lang === "zh" ? "完整提示词（复制给你的 Agent）" : "Prompt (copy to your Agent)"}</span>
                  <CopyBtn text={promptText} />
                </div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, lineHeight: 1.6, color: "var(--ink-soft)" }}>{promptText}</pre>
              </div>
              <div className="agent-tip">{t(`agent.${aid}.tip`)}</div>
            </div>
            );
          })}

          {/* Other */}
          <div className={`agent-setup ${selectedAgent === "other" ? "visible" : ""}`}>
            <div className="agent-question" style={{ marginBottom: 14 }}>{t("agent.other.intro")}</div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: "var(--ink)", letterSpacing: "0.5px", marginBottom: 8 }}>{t("agent.other.webhookTitle")}</div>
              <div className="agent-tip" style={{ marginBottom: 8 }}>{t("agent.other.webhookDesc")}</div>
              <div className="d-code-block">
                <div className="d-code-block-label">
                  <span>{t("agent.other.webhookLabel")}</span>
                  <CopyBtn text={`POST https://api.susurration.xyz/api/identity/webhook\nAuthorization: Bearer ${authToken || "sk_live_YOUR_TOKEN"}\nContent-Type: application/json\n\n{\n  "url": "https://your-agent.example.com/susu"\n}`} />
                </div>
                <pre>
                  <span className="tok-key">POST</span>{" "}<span className="tok-str">https://api.susurration.xyz/api/identity/webhook</span>{"\n"}
                  <span className="tok-key">Authorization:</span>{" "}<span className="tok-str">Bearer {maskToken(authToken || "sk_live_YOUR_TOKEN")}</span>{"\n"}
                  <span className="tok-key">Content-Type:</span>{" "}<span className="tok-str">application/json</span>{"\n\n"}
                  <span className="tok-punct">{"{"}</span>{"\n  "}
                  <span className="tok-key">"url"</span><span className="tok-punct">:</span>{" "}<span className="tok-str">"https://your-agent.example.com/susu"</span>{"\n"}
                  <span className="tok-punct">{"}"}</span>
                </pre>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--ink)", letterSpacing: "0.5px", marginBottom: 8 }}>{t("agent.other.sseTitle")}</div>
              <div className="agent-tip" style={{ marginBottom: 8 }}>{t("agent.other.sseDesc")}</div>
              <div className="d-code-block">
                <div className="d-code-block-label">
                  <span>{t("agent.other.sseLabel")}</span>
                  <CopyBtn text={`GET https://api.susurration.xyz/api/signals/feed/stream\nAuthorization: Bearer ${authToken || "sk_live_YOUR_TOKEN"}\nAccept: text/event-stream`} />
                </div>
                <pre>
                  <span className="tok-key">GET</span>{" "}<span className="tok-str">https://api.susurration.xyz/api/signals/feed/stream</span>{"\n"}
                  <span className="tok-key">Authorization:</span>{" "}<span className="tok-str">Bearer {maskToken(authToken || "sk_live_YOUR_TOKEN")}</span>{"\n"}
                  <span className="tok-key">Accept:</span>{" "}<span className="tok-str">text/event-stream</span>
                </pre>
              </div>
            </div>
            <div className="agent-tip" style={{ marginTop: 12 }}>
              {t("agent.other.docsDesc")}
            </div>
          </div>

          {/* Connection test */}
          <div className="conn-test">
            <div className="conn-test-label">{t("ob.conn.label")}</div>
            <button
              className={`conn-test-btn ${connState}`}
              disabled={connState === "testing" || connState === "success"}
              onClick={testConnection}
            >
              {connState === "testing" ? t("ob.conn.checking") + "…" :
               connState === "success" ? t("ob.conn.success") :
               connState === "fail" ? t("ob.conn.fail") :
               t("ob.conn.test")}
            </button>
            <div className="conn-test-status">
              {connState === "testing" && <span>{t("ob.conn.checking")}...</span>}
              {connState === "success" && <span style={{ color: "var(--green)" }}>{t("ob.conn.successDetail")}</span>}
              {connState === "fail" && (
                <ul className="conn-fail-help">
                  {connHelpKeys(selectedAgent).map((k) => <li key={k}>{t(k)}</li>)}
                </ul>
              )}
              {skipped && <span style={{ color: "var(--ink-faint)" }}>{t("ob.conn.skipped")}</span>}
            </div>
            {showSkip && !skipped && (
              <button className="conn-test-skip" onClick={() => { setSkipped(true); setShowSkip(false); }}>
                {t("ob.conn.skip")}
              </button>
            )}
          </div>

          <div className="onboard-nav">
            <button className="ob-btn-back" onClick={() => goStep(2)}>{t("ob.back")}</button>
            <button className="ob-btn-next" disabled={connState !== "success" && !skipped} onClick={() => {
              localStorage.setItem("susu_agent", selectedAgent);
              apiFetch("/friends/add", { method: "POST", body: JSON.stringify({ username: "demo" }) }).catch(() => {});
              onComplete();
            }}>{t("ob.enter")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
//   SIDEBAR
// ════════════════════════════════════════════════════════
function Sidebar({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  const { t } = useLang();
  const items: { id: Page; tip: string; icon: React.ReactNode; badge?: boolean }[] = [
    { id: "dashboard", tip: t("tip.dashboard"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="9" y="1.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="1.5" y="9" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
        <rect x="9" y="9" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    )},
    { id: "feed", tip: t("tip.activity"), badge: true, icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    )},
    { id: "friends", tip: t("tip.friends"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="6" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M1 13c0-2.76 2.24-5 5-5h0c2.76 0 5 2.24 5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="12" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.2"/>
        <path d="M12 10.5c1.66 0 3 1.34 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    )},
    { id: "mode", tip: t("tip.mode"), icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 13V8l4-5 4 5v5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        <path d="M4 13h8" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="8" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
      </svg>
    )},
    { id: "settings", tip: t("tip.settings"), icon: (
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
  const { t } = useLang();
  const auth = useAuth();
  const navigate = useNav();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [pricesLoaded, setPricesLoaded] = useState(false);

  useEffect(() => {
    apiFetch<{ friends: Friend[] }>("/friends").then(r => setFriends(r.friends)).catch(() => {});
    apiFetch<{ events: FeedItem[] }>("/signals/feed?limit=200").then(r => setFeed(r.events ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!auth.address || feed.length === 0) return;
    const raw = buildPositions(feed, auth.address);
    if (raw.length === 0) { setPositions([]); setPricesLoaded(true); return; }
    const symbols = [...new Set(raw.map(p => p.token))].join(",");
    apiFetch<{ prices: Record<string, number> }>(`/prices?symbols=${symbols}`)
      .then(r => { setPositions(applyPrices(raw, r.prices)); setPricesLoaded(true); })
      .catch(() => { setPositions(raw); setPricesLoaded(true); });
  }, [feed, auth.address]);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaySignals = feed.filter(f => f.kind === "signal" && new Date(f.created_at) >= todayStart).length;

  const totalPnl = positions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  const openPositions = positions.filter(p => p.status === "open").sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const closedPositions = positions.filter(p => p.status === "closed").sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const hasPositions = positions.length > 0;

  const agentId = localStorage.getItem("susu_agent") as AgentId | null;
  const agentName = agentId ? AGENTS.find(a => a.id === agentId)?.name ?? agentId : null;

  const pnlColor = totalPnl > 0 ? "#4caf50" : totalPnl < 0 ? "#ef5350" : "var(--ink-faint)";
  const pnlSign = totalPnl > 0 ? "+" : "";

  return (
    <div className="d-page active" style={{ display: "flex" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("dash.title")}</strong></div>
        {agentName && (
          <div className="agent-status-pill" title={`Connected via ${agentName}`}>
            <span className="agent-status-dot" />
            <span className="agent-status-label">{agentName}</span>
          </div>
        )}
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
                <div className="stat-value" style={{ color: pnlColor }}>{pnlSign}${Math.abs(totalPnl).toFixed(2)}</div>
                <div className="stat-sub" style={{ fontSize: 10, color: "var(--ink-faint)" }}>
                  {openPositions.length} {t("dash.posOpen")} · {closedPositions.length} {t("dash.posClosed")}
                </div>
              </>
            ) : (
              <div className="stat-value" style={{ color: "var(--ink-faint)" }}>—</div>
            )}
          </div>
        </div>

        {todaySignals === 0 && friends.length === 0 && (
          <div className="positions-card" style={{ textAlign: "center", padding: "32px 16px" }}>
            <div style={{ fontSize: 13, color: "var(--ink-faint)", marginBottom: 12 }}>{t("dash.noSignalsSub")}</div>
            <button className="btn-primary" style={{ fontSize: 12, padding: "8px 20px" }} onClick={() => navigate("friends")}>{t("dash.addFirstFriend")}</button>
          </div>
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
                <span>{t("dash.colPnl")}</span>
                <span>{t("dash.colFrom")}</span>
              </div>
              {openPositions.map(pos => {
                const c = (pos.pnlPct ?? 0) >= 0 ? "#4caf50" : "#ef5350";
                const s = (pos.pnlPct ?? 0) >= 0 ? "+" : "";
                return (
                  <div className="positions-row" key={pos.signalId}>
                    <span className="pos-token">{pos.token.replace(/USDT$/, "")}</span>
                    <span className={`pos-dir ${pos.direction}`}>{pos.direction.toUpperCase()} {pos.leverage}x</span>
                    <span className="pos-price">${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className="pos-price">{pos.currentPrice !== undefined ? `$${pos.currentPrice < 1 ? pos.currentPrice.toPrecision(4) : pos.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</span>
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

        {closedPositions.length > 0 && (
          <div className="positions-card" style={{ marginTop: 12 }}>
            <div className="section-header">
              <span className="section-title">{t("dash.closedPositions")}</span>
              <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{closedPositions.length}</span>
            </div>
            <div className="positions-table">
              <div className="positions-header">
                <span>{t("dash.colToken")}</span>
                <span>{t("dash.colDir")}</span>
                <span>{t("dash.colEntry")}</span>
                <span>{t("dash.colExit")}</span>
                <span>{t("dash.colPnl")}</span>
                <span>{t("dash.colReason")}</span>
              </div>
              {closedPositions.map(pos => {
                const c = (pos.pnlPct ?? 0) >= 0 ? "#4caf50" : "#ef5350";
                const s = (pos.pnlPct ?? 0) >= 0 ? "+" : "";
                return (
                  <div className="positions-row" key={pos.signalId}>
                    <span className="pos-token">{pos.token.replace(/USDT$/, "")}</span>
                    <span className={`pos-dir ${pos.direction}`}>{pos.direction.toUpperCase()} {pos.leverage}x</span>
                    <span className="pos-price">${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className="pos-price">${pos.exitPrice !== undefined ? (pos.exitPrice < 1 ? pos.exitPrice.toPrecision(4) : pos.exitPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })) : "—"}</span>
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

  // Build reaction counts + grouped reactions per signal
  const reactionCounts = new Map<string, { agrees: number; against: number }>();
  const reactionsMap = new Map<string, FeedItem[]>();
  for (const f of feed) {
    if (f.kind !== "reaction" || !f.parent_signal_id) continue;
    const c = reactionCounts.get(f.parent_signal_id) ?? { agrees: 0, against: 0 };
    if (f.payload?.value === "+1") c.agrees++;
    else if (f.payload?.value === "-1") c.against++;
    reactionCounts.set(f.parent_signal_id, c);
    const list = reactionsMap.get(f.parent_signal_id) ?? [];
    list.push(f);
    reactionsMap.set(f.parent_signal_id, list);
  }

  const filtered = feed.filter(f => {
    if (activeType === "reactions") return f.kind === "reaction";
    if (f.kind === "reaction" && f.parent_signal_id) return false;
    if (activeType === "signals") return f.kind === "signal";
    return true;
  });

  return (
    <div className="d-page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="d-page-header">
        <div className="d-page-title">susurration / <strong>{t("feed.title")}</strong></div>
        <div className="header-actions">
          <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{feed.length} {t("feed.items")}</span>
        </div>
      </div>
      <div className="feed-mobile-tabs">
        {["all", "signals", "reactions"].map((f) => (
          <button key={f} className={`feed-mobile-tab ${activeType === f ? "active" : ""}`} onClick={() => setActiveType(f)}>
            {t(`feed.${f}`)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div className="feed-main">
          {loading && <div style={{ padding: 24, color: "var(--ink-faint)", fontSize: 12 }}>{t("feed.loading")}</div>}
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
                    symbol={p.symbol ?? p.token ?? "—"} direction={p.direction === "short" ? "short" : "long"}
                    leverage={p.metadata?.leverage ?? p.leverage ?? "—"}
                    entry={p.metadata?.entry_price ?? p.entry_price ?? p.entry ?? "—"}
                    sltp={`${p.metadata?.stop_loss ?? p.sl ?? "—"} / ${p.metadata?.take_profit ?? p.tp ?? "—"}`}
                    reason={p.reason ?? p.reasoning ?? ""}
                    agrees={reactionCounts.get(item.signal_id!)?.agrees ?? 0}
                    against={reactionCounts.get(item.signal_id!)?.against ?? 0}
                  />
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
            return (
              <div className="signal-card" key={item.signal_id ?? item.reaction_id ?? item.created_at}>
                <div className="signal-card-head">
                  <div className="signal-avatar">{avatar}</div>
                  <div className="signal-meta">
                    <div className="handle">@{handle}</div>
                    <div className="ts">{formatTime(item.created_at)}</div>
                  </div>
                  <div className="signal-channel-badge">{channelLabel}</div>
                </div>
                <div className="signal-body-text" style={{ fontSize: 12 }}>
                  {typeof p === "object" ? (p.text ?? p.reasoning ?? JSON.stringify(p)) : String(p)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="feed-sidebar">
          <div>
            <div className="section-title" style={{ marginBottom: 10 }}>{t("feed.filter")}</div>
            <div style={{ fontSize: 10, color: "var(--ink-faint)", letterSpacing: "0.8px", textTransform: "uppercase", marginBottom: 6 }}>{t("feed.type")}</div>
            <div className="filter-chips">
              {["all", "signals", "reactions"].map((f) => (
                <button key={f} className={`filter-chip ${activeType === f ? "active" : ""}`} onClick={() => setActiveType(f)}>
                  {t(`feed.${f}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="feed-stat">
            <div className="section-title" style={{ marginBottom: 4 }}>{t("feed.today")}</div>
            <div className="feed-stat-row">
              <span className="k">{t("feed.signalsReceived")}</span>
              <span className="v">{feed.filter(f => f.kind === "signal").length}</span>
            </div>
            <div className="feed-stat-row">
              <span className="k">{t("feed.yourReacts")}</span>
              <span className="v">{feed.filter(f => f.kind === "reaction").length}</span>
            </div>
          </div>
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

  const reload = useCallback(() => {
    apiFetch<{ friends: Friend[] }>("/friends").then(r => { setFriends(r.friends); if (tab === "friends" && !selected && r.friends.length) setSelected(r.friends[0]!.friend_username ?? r.friends[0]!.friend_address); }).catch(() => {});
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
    try {
      await apiFetch(`/channels/${selectedGroup}/invite`, { method: "POST", body: JSON.stringify({ username: inviteVal.trim().replace(/^@/, "") }) });
      setInviteFb("sent");
      setInviteVal("");
      apiFetch<{ members: GroupMember[] }>(`/channels/${selectedGroup}/members`).then(r => setGroupMembers(r.members)).catch(() => {});
      reloadGroups();
      setTimeout(() => setInviteFb("idle"), 2000);
    } catch {
      setInviteFb("error");
      setTimeout(() => setInviteFb("idle"), 2000);
    }
  };

  const handleLeave = async (channelId: string) => {
    if (!confirm(lang === "zh" ? "确定退出群组？" : "Leave this group?")) return;
    try {
      await apiFetch(`/channels/${channelId}/leave`, { method: "POST" });
      setSelectedGroup(null);
      reloadGroups();
    } catch {}
  };

  const handleKick = async (channelId: string, addr: string, username: string | null) => {
    if (!confirm(lang === "zh" ? `确定踢出 @${username ?? addr.slice(0, 8)}？` : `Kick @${username ?? addr.slice(0, 8)}?`)) return;
    try {
      await apiFetch(`/channels/${channelId}/kick`, { method: "POST", body: JSON.stringify({ address: addr }) });
      apiFetch<{ members: GroupMember[] }>(`/channels/${channelId}/members`).then(r => setGroupMembers(r.members)).catch(() => {});
      reloadGroups();
    } catch {}
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
              {!friends.some(f => f.friend_username === "demo") && (
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
            const friendPositions = Object.keys(prices).length > 0 ? applyPrices(rawPositions, prices) : rawPositions;
            const friendPnl = friendPositions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);

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
                      <div style={{ fontSize: 16, fontWeight: 600, color: friendPnl > 0 ? "#4caf50" : friendPnl < 0 ? "#ef5350" : "var(--ink-faint)" }}>
                        {friendPnl !== 0 ? `${friendPnl > 0 ? "+" : ""}$${Math.abs(friendPnl).toFixed(2)}` : "—"}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 2 }}>{t("friends.pnl")}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12, textAlign: "center" }}>
                    <button
                      style={{ fontSize: 11, color: "var(--red)", background: "none", border: "0.5px solid var(--border2)", padding: "4px 14px", cursor: "pointer", borderRadius: 3, fontFamily: "var(--mono)", letterSpacing: "0.3px" }}
                      disabled={removingFriend === friendHandle}
                      onClick={() => {
                        if (!confirm(lang === "zh" ? `确定删除 @${friendHandle}？` : `Remove @${friendHandle}?`)) return;
                        setRemovingFriend(friendHandle);
                        apiFetch("/friends/remove", { method: "POST", body: JSON.stringify({ username: friendHandle }) })
                          .then(() => { setSelected(null); reload(); })
                          .catch(() => {})
                          .finally(() => setRemovingFriend(null));
                      }}
                    >
                      {removingFriend === friendHandle ? "…" : lang === "zh" ? "删除好友" : "Remove"}
                    </button>
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
              <div className="add-friend-row">
                <input className="add-friend-input" type="text" placeholder={t("groups.namePlaceholder")} value={createName} onChange={(e) => setCreateName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()} style={{ paddingLeft: 10 }} />
                <button className="add-btn" onClick={handleCreateGroup} disabled={creating}>
                  {creating ? t("groups.creating") : t("groups.create")}
                </button>
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
                    <div className="friend-avatar">{avatar}</div>
                    <div className="friend-info">
                      <div className="friend-handle" style={!g.name ? { color: "var(--ink-faint)", fontStyle: "italic" } : undefined}>{name}</div>
                      <div className="friend-last">{g.member_count} {g.member_count === 1 ? t("groups.member") : t("groups.members")}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {activeGroup && (
            <div className="friends-detail-col">
              <div className="friend-profile-card">
                <div className="friend-profile-top">
                  <div className="friend-avatar-lg">{(activeGroup.name || activeGroup.channel_id)[0]!.toUpperCase()}</div>
                  <div>
                    <div className="friend-name" style={!activeGroup.name ? { color: "var(--ink-faint)", fontStyle: "italic" } : undefined}>{activeGroup.name || t("groups.unnamed")}</div>
                    <div className="friend-sub">{activeGroup.member_count} {activeGroup.member_count === 1 ? t("groups.member") : t("groups.members")} · {new Date(activeGroup.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
                {/* Invite row */}
                {activeGroup.owner === auth.address ? (
                  <div style={{ display: "flex", gap: 6, marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12 }}>
                    <span style={{ color: "var(--ink-faint)", fontSize: 12, lineHeight: "28px" }}>@</span>
                    <input type="text" placeholder={t("groups.invitePlaceholder")} value={inviteVal} onChange={(e) => setInviteVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleInvite()} style={{ flex: 1, background: "var(--surface)", border: "0.5px solid var(--border-base)", borderRadius: 6, padding: "4px 8px", fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)", outline: "none" }} />
                    <button className="add-btn" onClick={handleInvite} disabled={inviteFb === "sending"} style={inviteFb === "sent" ? { color: "var(--green)" } : inviteFb === "error" ? { color: "var(--red)" } : undefined}>
                      {inviteFb === "sending" ? t("groups.inviting") : inviteFb === "sent" ? t("groups.invited") : t("groups.invite")}
                    </button>
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
                    const iAmOwner = activeGroup.owner === auth.address;
                    return (
                      <div key={m.address} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "0.5px solid var(--border-base)" }}>
                        <div className="friend-avatar" style={{ width: 24, height: 24, fontSize: 10, lineHeight: "24px" }}>{(m.username || m.address)[0]!.toUpperCase()}</div>
                        <div style={{ flex: 1, fontSize: 12, fontFamily: "var(--mono)", color: "var(--ink)" }}>
                          @{handle}
                          {isOwner && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-faint)" }}>({t("groups.owner")})</span>}
                          {isMe && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-faint)" }}>({t("groups.you")})</span>}
                        </div>
                        {iAmOwner && !isMe && (
                          <button onClick={() => handleKick(activeGroup.channel_id, m.address, m.username)} style={{ fontSize: 11, color: "var(--red)", background: "none", border: "0.5px solid var(--border2)", padding: "2px 8px", cursor: "pointer", borderRadius: 4, fontFamily: "var(--mono)", letterSpacing: "0.3px" }}>
                            {t("groups.kick")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Leave button */}
                <div style={{ marginTop: 16, borderTop: "0.5px solid var(--border-base)", paddingTop: 12, textAlign: "center" }}>
                  <button
                    onClick={() => handleLeave(activeGroup.channel_id)}
                    style={{ fontSize: 11, color: "var(--red)", background: "none", border: "0.5px solid var(--border2)", padding: "4px 14px", cursor: "pointer", borderRadius: 4, fontFamily: "var(--mono)", letterSpacing: "0.3px" }}
                  >
                    {t("groups.leave")}
                  </button>
                </div>
              </div>
            </div>
          )}
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
  const setPagePersist = useCallback((p: Page) => { localStorage.setItem("susu_page", p); setPage(p); }, []);
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([page]));
  useEffect(() => { setVisited(v => v.has(page) ? v : new Set(v).add(page)); }, [page]);

  const authCtx: AuthCtx = {
    token: localStorage.getItem("susu_token"),
    username: localStorage.getItem("susu_handle"),
    address: localStorage.getItem("susu_address"),
  };

  return (
    <AuthContext.Provider value={authCtx}>
      <NavContext.Provider value={setPagePersist}>
        <div className="dash-shell">
          {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}
          <Sidebar page={page} setPage={setPagePersist} />
          <div className="dash-content">
            {visited.has("dashboard") && <div style={{ display: page === "dashboard" ? "flex" : "none", flexDirection: "column", height: "100%" }}><DashHome /></div>}
            {visited.has("feed") && <div style={{ display: page === "feed" ? "flex" : "none", flexDirection: "column", height: "100%" }}><FeedPage /></div>}
            {visited.has("friends") && <div style={{ display: page === "friends" ? "flex" : "none", flexDirection: "column", height: "100%" }}><FriendsPage /></div>}
            {visited.has("mode") && <div style={{ display: page === "mode" ? "flex" : "none", flexDirection: "column", height: "100%" }}><ModePage /></div>}
            {visited.has("settings") && <div style={{ display: page === "settings" ? "flex" : "none", flexDirection: "column", height: "100%" }}><SettingsPage onShowOnboarding={() => setShowOnboarding(true)} /></div>}
          </div>
        </div>
      </NavContext.Provider>
    </AuthContext.Provider>
  );
}
