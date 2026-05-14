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

export async function whoami(cfg: SusuClientConfig): Promise<{ address: string; username: string | null; handle: string | null }> {
  const resp = await authedFetch(cfg, `/me`);
  if (!resp.ok) throw new Error(`whoami HTTP ${resp.status}: ${await resp.text()}`);
  return await resp.json() as any;
}

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
 *  (not connected). Backend endpoint accepts every decision including noop. */
export function reportDaemonDecision(
  cfg: SusuClientConfig,
  params: {
    kind: "react" | "noop" | "push" | "error";
    signal_id?: string;
    event_kind?: string;
    error_type?: string;
    latency_ms?: number;
    context?: Record<string, unknown>;
  },
): void {
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
