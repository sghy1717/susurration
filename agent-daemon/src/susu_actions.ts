// HTTP wrappers around the Susurration backend for the actions the daemon
// performs on behalf of the user. Kept separate from the LLM provider so
// the same action functions are reusable when we add CLI commands like
// `susu agent-daemon dry-run`.

// Bun bundles this at build time — resolved from package.json, no runtime env needed.
// @ts-ignore — Bun resolves JSON imports at bundle time
import pkg from "../package.json";
import { redactSecrets, redactSecretsDeep } from "../../shared/redact.ts";
export const DAEMON_VERSION: string = pkg.version ?? "unknown";

export interface SusuClientConfig {
  api_url: string;
  token: string;
}

export interface PostSignalResult {
  signal_id: string;
  channel_id: string;
  cost_usd: number;
}

export interface PostReactionResult {
  reaction_id: string;
  signal_id: string;
  channel_id: string;
  cost_usd: number;
}

async function authedFetch(cfg: SusuClientConfig, path: string, init?: RequestInit) {
  const url = cfg.api_url.replace(/\/$/, "") + path;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${cfg.token}`,
  };
  if (init?.headers) Object.assign(headers, init.headers);
  return fetch(url, { ...init, headers });
}

export async function pushSignal(
  cfg: SusuClientConfig,
  channelId: string,
  payload: Record<string, unknown>,
): Promise<PostSignalResult> {
  const resp = await authedFetch(cfg, `/channels/${channelId}/signals`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`pushSignal HTTP ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as any;
  return { signal_id: j.signal_id, channel_id: j.channel_id, cost_usd: j.cost_usd ?? 0 };
}

export async function pushReaction(
  cfg: SusuClientConfig,
  signalId: string,
  payload: Record<string, unknown>,
  isAuto = true,
): Promise<PostReactionResult> {
  const resp = await authedFetch(cfg, `/signals/${signalId}/reactions`, {
    method: "POST",
    // Mark agent-originated reactions with is_auto=true so peers can tell
    // them apart from human-typed reactions in their inbox UI.
    body: JSON.stringify({ payload, is_auto: isAuto }),
  });
  if (!resp.ok) throw new Error(`pushReaction HTTP ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as any;
  return {
    reaction_id: j.reaction_id,
    signal_id: j.signal_id,
    channel_id: j.channel_id,
    cost_usd: j.cost_usd ?? 0,
  };
}

export interface ChannelHistory {
  signals: any[];
}

export async function recentSignals(
  cfg: SusuClientConfig,
  channelId: string,
  limit = 20,
): Promise<ChannelHistory> {
  const resp = await authedFetch(cfg, `/channels/${channelId}/signals?limit=${limit}`);
  if (!resp.ok) throw new Error(`recentSignals HTTP ${resp.status}: ${await resp.text()}`);
  return await resp.json() as ChannelHistory;
}

// 2026-05-18 G review P1 #3 — whoami() pointed at /me which 404s
// (real endpoint is /identity/whoami). Function had zero callers in
// agent-daemon. Removed rather than fixed-and-kept-unused.

export function reportClientError(
  cfg: SusuClientConfig,
  errorType: string,
  message: string,
  context?: Record<string, string>,
): void {
  const version = DAEMON_VERSION;
  void authedFetch(cfg, `/client-errors`, {
    method: "POST",
    body: JSON.stringify({
      source: "daemon",
      version,
      error_type: errorType,
      message: redactSecrets(message).slice(0, 500),
      context: context ? redactSecretsDeep(context) : context,
    }),
  }).catch(() => {});
}

/** Report daemon decision telemetry. Fire-and-forget — never throws.
 *  Used to distinguish "silent daemon" (running but all noop) vs "dead daemon"
 *  (not connected). Backend endpoint accepts every decision including noop.
 *
 *  Phase 11b — also dual-writes to /daemon_decisions (caller-bound, plaintext
 *  for cross-device dashboard query). The legacy /daemon/decision endpoint
 *  stays (analytics/funnel hash). reasoning_summary cap at 500 chars. */
export function reportDaemonDecision(
  cfg: SusuClientConfig,
  params: {
    /** invoke = Phase 18 IDE-agent runner dispatched the event; the agent's
     *  actual react / push / noop choice now shows up directly on backend
     *  (no central daemon view of it). react / noop / push retained for
     *  back-compat in case future runner code paths attempt to introspect. */
    kind: "react" | "noop" | "push" | "error" | "invoke";
    signal_id?: string;
    channel_id?: string;
    reaction_id?: string;
    event_kind?: string;
    error_type?: string;
    latency_ms?: number;
    llm_provider?: string;
    llm_model?: string;
    reasoning_summary?: string;
    context?: Record<string, unknown>;
    // 2026-05-18 ADR remove-platform-paternalism §What we add #9.
    // Parsed from claude stream-json; LOCAL ONLY (caller-bound row, never
    // pushed to peer channels). Persisted in daemon_decisions for the
    // user's own dashboard / "tools used" reveal so thesis tangibly
    // delivers.
    tools_used?: Array<{ name: string; input: unknown }>;
    permission_denials?: unknown[];
    cost_usd?: number;
  },
): void {
  // Hashed analytics path (legacy)
  void authedFetch(cfg, `/daemon/decision`, {
    method: "POST",
    body: JSON.stringify({
      kind: params.kind,
      ...(params.signal_id ? { signal_id: params.signal_id } : {}),
      ...(params.event_kind ? { event_kind: params.event_kind } : {}),
      ...(params.error_type ? { error_type: params.error_type } : {}),
      ...(params.latency_ms != null ? { latency_ms: params.latency_ms } : {}),
      context: { version: DAEMON_VERSION, ...(params.context ? redactSecretsDeep(params.context as Record<string, unknown>) : {}) },
    }),
  }).catch(() => {});
  // Phase 11b — caller-bound plaintext for cross-device user-visible decision history.
  // 2026-05-18 ADR remove-platform-paternalism §What we add #9: tools_used /
  // permission_denials / cost_usd come from claude stream-json parse. They
  // STAY caller-bound (this row is fetched only by the caller via
  // /daemon_decisions/mine) — never copied into peer-facing payloads.
  void authedFetch(cfg, `/daemon_decisions`, {
    method: "POST",
    body: JSON.stringify({
      kind: params.kind,
      ...(params.signal_id ? { signal_id: params.signal_id } : {}),
      ...(params.channel_id ? { channel_id: params.channel_id } : {}),
      ...(params.reaction_id ? { reaction_id: params.reaction_id } : {}),
      ...(params.event_kind ? { event_kind: params.event_kind } : {}),
      ...(params.error_type ? { error_type: params.error_type } : {}),
      ...(params.latency_ms != null ? { latency_ms: params.latency_ms } : {}),
      ...(params.llm_provider ? { llm_provider: params.llm_provider } : {}),
      ...(params.llm_model ? { llm_model: params.llm_model } : {}),
      // Redact FIRST, slice SECOND — redaction can shorten a `sk-...XYZ`
      // pattern into a 6-char `sk-***` token, which could free room
      // earlier-trimmed content otherwise wouldn't have had. Server also
      // applies a slice(500) defensively (daemon_decisions.ts), so either
      // order would land at ≤500 chars on disk; this order keeps the slice
      // window aligned with what the user actually sees post-redaction.
      // (G review P1 #10, 2026-05-18 — explanation added; behavior unchanged.)
      ...(params.reasoning_summary ? { reasoning_summary: redactSecrets(params.reasoning_summary).slice(0, 500) } : {}),
      // 2026-05-18 G review #2 — tools_used.input may carry shell commands
      // / API URLs / file contents with embedded secrets (sk-..., Bearer
      // tokens, broker API keys). caller-bound ACL on /daemon_decisions/mine
      // limits READ but server-side DB / backups / dbadmin still see
      // plaintext. Pass through redactSecretsDeep like reasoning_summary
      // and reportClientError do. Same for permission_denials (denial
      // metadata may quote the attempted command).
      ...(params.tools_used && params.tools_used.length > 0 ? { tools_used: redactSecretsDeep(params.tools_used as unknown as Record<string, unknown>) } : {}),
      ...(params.permission_denials && params.permission_denials.length > 0 ? { permission_denials: redactSecretsDeep(params.permission_denials as unknown as Record<string, unknown>) } : {}),
      ...(params.cost_usd != null ? { cost_usd: params.cost_usd } : {}),
    }),
  }).catch(() => {});
}

/** Phase 11a — Sync paper position open to server (cross-device). Fire-and-forget. */
export function syncPaperOpen(
  cfg: SusuClientConfig,
  params: {
    signal_id: string;
    channel_id: string;
    token: string;
    direction: "long" | "short";
    leverage: number;
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    position_usd: number;
    size_factor?: number;
    peer_username?: string;
    is_replay?: boolean;
    opened_at?: string;
    daemon_local_id?: string;
  },
): void {
  void authedFetch(cfg, `/positions/open`, {
    method: "POST",
    body: JSON.stringify(params),
  }).catch(() => {});
}

/** Phase 11a — Sync paper position close to server. Fire-and-forget. */
/** Phase 17.5 — Returns a Promise that resolves on 2xx and throws on
 *  network error / non-2xx. Caller (PaperCloseQueue) needs to distinguish
 *  success from failure to retry on failure. Pre-17.5 this was fire-and-
 *  forget with .catch(()=>{}) — that swallowed close failures and was the
 *  root cause of the in-flight-crash data loss this fix targets. */
export async function syncPaperClose(
  cfg: SusuClientConfig,
  params: {
    signal_id: string;
    exit_reason: string;
    exit_price: number;
    exit_pnl_pct: number;
    exit_pnl_usd?: number;
    closed_at?: string;
  },
): Promise<void> {
  // 15s timeout — network hang would otherwise block trackPositions tick and
  // pin flushInFlight=true, preventing newer enqueues from getting their
  // first attempt until OS TCP timeout (~75s on macOS) fires.
  const resp = await authedFetch(cfg, `/positions/close`, {
    method: "POST",
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`syncPaperClose HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
}

/** Phase 11a — Backfill: fetch open positions from server (after daemon
 *  reinstall / new device) so local paper_trades.json can be reconstituted. */
export async function fetchPaperPositionsMine(
  cfg: SusuClientConfig,
  status: "open" | "closed" | "all" = "open",
): Promise<{ positions: any[] }> {
  const resp = await authedFetch(cfg, `/positions/mine?status=${status}`);
  if (!resp.ok) return { positions: [] };
  return await resp.json() as any;
}

/** Cross-channel poll: returns events newer than `since` across every
 *  channel the user is in. Used by `--once` mode to catch up on the
 *  inbox without holding an SSE stream open. Server returns DESC; the
 *  caller should reverse to chrono order if needed. */
export async function feedSince(
  cfg: SusuClientConfig,
  sinceIso: string | null,
  limit = 200,
): Promise<{ signals: any[] }> {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (sinceIso) qs.set("since", sinceIso);
  const resp = await authedFetch(cfg, `/signals/feed?${qs.toString()}`);
  if (!resp.ok) throw new Error(`feedSince HTTP ${resp.status}: ${await resp.text()}`);
  return await resp.json() as any;
}
