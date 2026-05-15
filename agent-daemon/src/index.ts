// susu-agent-daemon — long-running process that watches the user's Susurration
// channels and acts on incoming signals via the user's own LLM API key.
//
// Architecture:
//
//   ┌─ susurration backend SSE  ──┐
//   │   /signals/feed/stream      │
//   └──────────┬──────────────────┘
//              ▼ (1) parse incoming event
//   ┌─ daemon main loop ────────────────────────────────┐
//   │  filter:                                          │
//   │   • skip own events                               │
//   │   • skip non-channel-scope events (friend_*, ...) │
//   │  build context: recent_events + triggering_event  │
//   │  rate-check (per-minute cap)                      │
//   │  ▼                                                │
//   │  LLM.decide(ctx)  ──► AgentDecision               │
//   │   • {kind: noop}                                  │
//   │   • {kind: react, signal_id, payload}             │
//   │   • {kind: push, channel_id, payload}             │
//   │  ▼                                                │
//   │  execute via susu_actions HTTP                    │
//   │  ▼                                                │
//   │  decision_log → terminal + JSONL file             │
//   └───────────────────────────────────────────────────┘
//
// Why subscribe to /signals/feed/stream (not per-channel /signals/stream):
//   feed-stream is the canonical "all channels I'm in" fan-in. The daemon
//   doesn't need to know which channels exist — it follows whatever the
//   server tells it the user is a member of, including channels added
//   after the daemon started (BETA-1.c's feed-stream extender wires that
//   up automatically).

import { readFile, writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  AnthropicProvider, OpenAIProvider,
  type LLMProvider, type AgentContext, type AgentDecision,
} from "./llm.ts";
import { DecisionLog } from "./decision_log.ts";
import { PaperTrader } from "./paper_trading.ts";
import { normalizeSignalPayload } from "./normalize.ts";
import {
  pushSignal, pushReaction, recentSignals, feedSince,
  reportClientError, reportDaemonDecision, DAEMON_VERSION,
  type SusuClientConfig,
} from "./susu_actions.ts";

// ── Config ───────────────────────────────────────────────────────────────

interface DaemonConfig {
  api_url: string;
  token: string;
  llm: {
    provider: "anthropic" | "openai";
    api_key: string;
    model: string;
    /** Custom base URL for OpenAI-compatible APIs (DeepSeek, Gemini, Ollama, etc.) */
    base_url?: string;
  };
  agent: {
    system_prompt: string;
    /** Per-minute LLM call cap. Defaults to 10. */
    max_calls_per_minute?: number;
    /** How many recent events to feed the LLM as context. Defaults to 20. */
    history_per_channel?: number;
  };
  /** Daemon will write a JSONL log of every decision to this path. */
  decision_log_path?: string;
  /** SET TO false ONLY DURING TESTING — daemon refuses to push signals
   *  (only react/noop) when true. Default: true (safe by default). */
  dry_run_pushes?: boolean;
  /** State file for `--once` poll mode: tracks the last event timestamp
   *  successfully processed so subsequent runs only handle new events.
   *  Defaults to `~/.susu/agent-daemon.state.json`. Ignored in long-running
   *  SSE mode (the SSE stream is inherently stateful). */
  state_path?: string;
  /** Built-in paper trading. When enabled, daemon opens paper positions
   *  on react +1 decisions with size_factor >= min_size_factor. In-process,
   *  zero spawn overhead. Writes to ~/.susu/paper_trades.json. */
  paper_trading?: {
    enabled: boolean;
    min_size_factor?: number;  // default 0.5
    max_open?: number;         // default unlimited (no cap)
  };
  /** Optional: shell command executed after every decision. For bridging
   *  to external trading systems (broker API, DEX, webhook). JSON on stdin.
   *  Most users should use paper_trading instead. */
  on_decision?: string;
  /** Path for local event log (all SSE events, not just decisions).
   *  Used by `susu feed` to display history without a second SSE connection. */
  event_log_path?: string;
  /** Phase 14 G #1 — Privacy opt-in. When TRUE, daemon uploads its LLM
   *  decision `note` (capped 500 chars, secrets redacted) to Susurration
   *  server's `daemon_decisions` table. Lets you see decision history
   *  cross-device on dashboard. When FALSE (default), only react/push/noop
   *  metadata is shared (the kind, signal_id, latency); the note string
   *  stays local in `~/.susu/agent-decisions.jsonl`.
   *  Default: false (your LLM reasoning is your alpha; opt-in to share). */
  share_reasoning_summary?: boolean;
}

function parseArgs(argv: string[]): { config?: string; once?: boolean } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") out.config = argv[++i];
    else if (a === "--once") out.once = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`susu-agent-daemon — your agent on Susurration

Usage:
  susu-agent-daemon --config agent.config.json           # long-running SSE mode
  susu-agent-daemon --config agent.config.json --once    # poll-once mode (cron-friendly)

Modes:
  Default (long-running):  Subscribes to /signals/feed/stream over SSE; reacts
                           to events in real time. Requires the host machine
                           to stay awake/online — best for always-on devices
                           (Mac mini, home server, VPS, dedicated container).

  --once (poll mode):      Pulls events newer than last_seen via /signals/feed,
                           processes them all, writes new last_seen, exits.
                           Pair with cron / launchd / systemd timer to run
                           every N minutes. Latency = your scheduler interval.
                           Works on a laptop that sleeps overnight.

Cron example (every 2 min — recommended for paper trading):
  */2 * * * * /usr/local/bin/susu-agent-daemon --config /home/me/agent.config.json --once


Config file shape (.json):
  {
    "api_url": "https://susurration.xyz/api",
    "token": "<bearer from susu login>",
    "llm": {
      "provider": "anthropic" | "openai",
      "api_key": "<your llm api key>",
      "model": "claude-sonnet-4-6" | "gpt-5" | ...
    },
    "agent": {
      "system_prompt": "You are <name>'s trading agent on Susurration.\\nWhen a peer pushes a trade signal, evaluate against my risk caps...",
      "max_calls_per_minute": 10,
      "history_per_channel": 20
    },
    "decision_log_path": "~/.susu/agent-decisions.jsonl",
    "dry_run_pushes": true,
    "paper_trading": { "enabled": true }
  }

paper_trading (default: enabled):
  Built-in paper trading. On react +1 with size_factor >= 0.5, opens a
  paper position in ~/.susu/paper_trades.json. In-process, zero overhead.
  Customize min_size_factor (default 0.5) and max_open (default unlimited).

on_decision (optional, for power users):
  Shell command fired after every decision. JSON context on stdin.
  Use to bridge to your own trading system (broker API, DEX, webhook).
  Most users don't need this — paper_trading handles the default case.

Behavior:
  - Subscribes to your /signals/feed/stream over SSE.
  - For every incoming signal/reaction (NOT your own), calls your LLM
    with the recent channel context and lets it choose: do_nothing,
    react_to_signal, or push_signal.
  - Auto-reconnects on SSE drop with exponential backoff.
  - dry_run_pushes=true (default): refuses push_signal decisions; reacts
    are still allowed. Flip to false once you trust the agent.
  - All decisions stream to stdout AND append to decision_log_path.
`);
}

async function loadConfig(args: ReturnType<typeof parseArgs>): Promise<DaemonConfig> {
  if (!args.config) throw new Error("missing --config <path>");
  const raw = await readFile(args.config, "utf8");
  const parsed = JSON.parse(raw) as DaemonConfig;
  // Apply defaults.
  parsed.dry_run_pushes = parsed.dry_run_pushes ?? true;
  parsed.agent.max_calls_per_minute = parsed.agent.max_calls_per_minute ?? 10;
  parsed.agent.history_per_channel = parsed.agent.history_per_channel ?? 20;
  parsed.state_path = parsed.state_path ?? `${process.env.HOME ?? "."}/.susu/agent-daemon.state.json`;
  parsed.event_log_path = parsed.event_log_path ?? `${process.env.HOME ?? "."}/.susu/events.jsonl`;
  return parsed;
}

// ── State (--once mode only) ─────────────────────────────────────────────
//
// Persists last_seen_iso between runs so polling doesn't re-process the
// same events on every cron tick. Long-running SSE mode doesn't use this —
// the open stream is its own continuity mechanism.

interface DaemonState {
  last_seen_iso: string | null;
}

async function loadState(path: string): Promise<DaemonState> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return { last_seen_iso: null };
  }
}

async function saveState(path: string, state: DaemonState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

// ── Rate limiter (per-minute LLM calls) ──────────────────────────────────

class MinuteRateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number) {}
  /** Returns true if we're under the cap; records the call timestamp. */
  tryConsume(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────

async function checkForUpdate(): Promise<void> {
  try {
    const resp = await fetch("https://registry.npmjs.org/susurration-agent-daemon/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return;
    const data = await resp.json() as { version?: string };
    if (data.version && data.version !== DAEMON_VERSION) {
      process.stderr.write(`\n${"═".repeat(60)}\n`);
      process.stderr.write(`  ⬆️  UPDATE AVAILABLE: ${DAEMON_VERSION} → ${data.version}\n\n`);
      process.stderr.write(`  Run: npm update -g susurration-agent-daemon\n`);
      process.stderr.write(`  Then restart the daemon.\n`);
      process.stderr.write(`${"═".repeat(60)}\n\n`);
    }
  } catch { /* best effort */ }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  checkForUpdate();
  const cfg = await loadConfig(args);
  const susu: SusuClientConfig = { api_url: cfg.api_url, token: cfg.token };

  const provider: LLMProvider = cfg.llm.provider === "openai"
    ? new OpenAIProvider(cfg.llm.api_key, cfg.llm.model, cfg.llm.base_url)
    : new AnthropicProvider(cfg.llm.api_key, cfg.llm.model);

  const log = new DecisionLog(cfg.decision_log_path);
  const limiter = new MinuteRateLimiter(cfg.agent.max_calls_per_minute!);

  // Built-in paper trading (replaces the old on_decision hook spawn pattern).
  // Phase 11a — pass susu client so opens/closes mirror to server for
  // cross-device visibility. New device login → dashboard sees full history.
  const paperTrader = cfg.paper_trading?.enabled
    ? new PaperTrader(
        join(process.env.HOME ?? ".", ".susu", "paper_trades.json"),
        cfg.paper_trading.min_size_factor ?? 0.5,
        cfg.paper_trading.max_open,
        cfg.event_log_path,
        susu,
      )
    : null;
  // Phase 11a — best-effort startup backfill from server (after reinstall / new device).
  if (paperTrader) {
    void paperTrader.syncFromServerOnce();
  }

  // Discover own address + handle so we can skip self-events.
  let myAddress: string | null = null;
  let myHandle: string | null = null;
  try {
    const meResp = await fetch(susu.api_url.replace(/\/$/, "") + "/identity/whoami", {
      headers: { authorization: `Bearer ${susu.token}` },
    });
    if (meResp.ok) {
      const me = await meResp.json() as any;
      myAddress = me.address ?? null;
      myHandle = me.handle ?? me.username ?? null;
    }
  } catch { /* fall through; daemon can still run, just won't filter self-events */ }

  const mode = args.once ? "poll-once" : "stream";
  process.stderr.write(
    `[daemon] starting as ${myHandle ? `@${myHandle}` : `(${myAddress?.slice(0, 8) ?? "anon"})`}, ` +
    `mode=${mode}, ` +
    `provider=${cfg.llm.provider}/${cfg.llm.model}, ` +
    `dry_run_pushes=${cfg.dry_run_pushes}` +
    `${paperTrader ? ", paper_trading=on" : ""}` +
    `, cap=${cfg.agent.max_calls_per_minute}/min\n`,
  );

  if (args.once) {
    return await runOncePoll(susu, provider, log, limiter, cfg, myAddress, paperTrader);
  }

  // ── PID file + graceful shutdown ──────────────────────────────────────
  const pidPath = join(process.env.HOME ?? ".", ".susu", "agent-daemon.pid");
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(process.pid), "utf8");
  const cleanupPid = () => { try { unlinkSync(pidPath); } catch {} };
  process.on("exit", cleanupPid);

  let stopped = false;
  const abortCtl = new AbortController();
  const gracefulStop = (sig: string) => {
    if (stopped) return;
    stopped = true;
    abortCtl.abort();
    process.stderr.write(`\n[daemon] stopping (${sig})\n`);
  };
  process.on("SIGINT", () => { gracefulStop("SIGINT"); });
  process.on("SIGTERM", () => { gracefulStop("SIGTERM"); });

  // Start paper trading position tracker (60s interval).
  if (paperTrader) paperTrader.startTracking();

  // Reconnect loop: same exponential backoff pattern as cli watch.
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;
  while (!stopped) {
    const startedAt = Date.now();
    try {
      await runOneStream(susu, provider, log, limiter, cfg, myAddress, paperTrader, abortCtl.signal);
    } catch (err) {
      if (stopped) break;
      const msg = (err as Error)?.message ?? String(err);
      process.stderr.write(`[daemon] stream error: ${msg}\n`);
      reportClientError(susu, "stream_error", msg);
    }
    if (stopped) break;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 30_000) backoffMs = 1000;
    process.stderr.write(`[daemon] reconnecting in ${(backoffMs / 1000).toFixed(1)}s...\n`);
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
  }

  // Cleanup.
  if (paperTrader) paperTrader.stopTracking();
  return 0;
}

// ── Dedup (--once mode) ──────────────────────────────────────────────────
//
// Reads the decision log JSONL and collects all event IDs that were already
// evaluated (react, noop, push — any decision counts). This prevents --once
// cron ticks from re-evaluating signals that feedSince returns again.

function loadAlreadyProcessedIds(decisionLogPath?: string): Set<string> {
  const ids = new Set<string>();
  if (!decisionLogPath) return ids;
  try {
    const content = readFileSync(decisionLogPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const trig = entry.triggering_event;
        if (trig?.signal_id) ids.add(trig.signal_id);
        if (trig?.reaction_id) ids.add(trig.reaction_id);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file doesn't exist yet — first run */ }
  return ids;
}

// ── --once poll mode ─────────────────────────────────────────────────────
//
// Single batch: load last_seen state → fetch /signals/feed?since=<ts> →
// process every actionable event in chronological order → save the latest
// timestamp → exit. Designed to be triggered by cron / launchd / systemd
// timer every N minutes on machines that aren't always-on.

async function runOncePoll(
  susu: SusuClientConfig,
  provider: LLMProvider,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myAddress: string | null,
  paperTrader: PaperTrader | null,
): Promise<number> {
  const state = await loadState(cfg.state_path!);
  process.stderr.write(`[daemon] poll-once: last_seen=${state.last_seen_iso ?? "(none)"}\n`);

  let events: any[] = [];
  try {
    const r = await feedSince(susu, state.last_seen_iso, 200);
    events = r.signals ?? [];
  } catch (err) {
    process.stderr.write(`[daemon] feed fetch failed: ${(err as Error)?.message ?? err}\n`);
    return 1;
  }

  events.reverse();

  // Dedup: skip events already evaluated in previous --once runs.
  const processed = loadAlreadyProcessedIds(cfg.decision_log_path);

  const actionable = events.filter((e) => {
    if (e?.kind !== "signal" && e?.kind !== "reaction") return false;
    if (myAddress && e.from_address === myAddress) return false;
    const eventId = e.signal_id ?? e.reaction_id;
    if (eventId && processed.has(eventId)) return false;
    return true;
  });

  const skipped = events.filter((e) => {
    const eid = e?.signal_id ?? e?.reaction_id;
    return eid && processed.has(eid);
  }).length;

  process.stderr.write(
    `[daemon] poll-once: ${events.length} new event(s), ${actionable.length} actionable` +
    `${skipped > 0 ? `, ${skipped} already-processed skipped` : ""}\n`,
  );

  for (const evt of actionable) {
    try {
      await handleEvent(evt, susu, provider, log, limiter, cfg, paperTrader);
    } catch (err) {
      process.stderr.write(`[daemon] handle error on ${evt.signal_id ?? evt.reaction_id ?? "?"}: ${(err as Error)?.message ?? err}\n`);
    }
  }

  // Check open paper positions against current prices (SL/TP/trailing/time).
  // In stream mode this runs on a 60s interval; in --once mode we check once
  // after processing all events so positions opened by earlier cron ticks
  // (or this tick) get evaluated.
  if (paperTrader) await paperTrader.checkOnce();

  const newest = events.length > 0 ? events[events.length - 1].created_at : state.last_seen_iso;
  if (newest && newest !== state.last_seen_iso) {
    await saveState(cfg.state_path!, { last_seen_iso: newest });
    process.stderr.write(`[daemon] poll-once: advanced last_seen → ${newest}\n`);
  }

  return 0;
}

// ── LLM auth error tracking ─────────────────────────────────────────────
// Shared across handleEvent calls within a stream session. When the user's
// LLM API key is wrong, every event triggers a 401 — we detect the pattern
// and pause with a loud banner instead of silently burning through errors.
const LLM_AUTH_PAUSE_THRESHOLD = 3;
const LLM_AUTH_PAUSE_SECONDS = 300;  // 5 min cooldown between retries
let llmAuthErrorCount = 0;
let llmAuthPausedUntil = 0;

function isLlmAuthError(msg: string): boolean {
  return /\b(401|403|Incorrect API key|invalid.*api.?key|authentication|unauthorized)\b/i.test(msg);
}

function isLlmQuotaError(msg: string): boolean {
  return /\b(429|quota|rate.?limit|exceeded.*quota|billing)\b/i.test(msg);
}

async function runOneStream(
  susu: SusuClientConfig,
  provider: LLMProvider,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myAddress: string | null,
  paperTrader: PaperTrader | null,
  signal?: AbortSignal,
): Promise<void> {
  const url = susu.api_url.replace(/\/$/, "") + "/signals/feed/stream";
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${susu.token}` },
    signal,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`auth failed (HTTP ${resp.status}); your token may have expired — re-run \`susu login\` and update config`);
  }
  if (resp.status === 429) {
    throw new Error("too_many_streams (HTTP 429) — close other watch/feed sessions");
  }
  if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);

  // Dedup: load IDs already decided on from previous runs / reconnects.
  const processed = loadAlreadyProcessedIds(cfg.decision_log_path);
  process.stderr.write(`[daemon] stream: loaded ${processed.size} already-processed event IDs\n`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message", data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "ping" || event === "open" || event === "ejected") continue;
      if (!data) continue;
      let evt: any;
      try { evt = JSON.parse(data); } catch { continue; }

      // Write ALL events to local event log (for `susu feed` to read
      // without opening a second SSE connection).
      if (cfg.event_log_path) {
        appendFile(cfg.event_log_path, JSON.stringify(evt) + "\n", "utf8").catch(() => {});
      }

      // System broadcasts — print to terminal immediately.
      if (evt?.kind === "system") {
        const level = evt.level ?? "info";
        const icon = level === "urgent" ? "🚨" : level === "warn" ? "⚠️" : "ℹ️";
        process.stderr.write(`\n${"═".repeat(60)}\n`);
        process.stderr.write(`  ${icon}  SYSTEM: ${evt.message}\n`);
        process.stderr.write(`${"═".repeat(60)}\n\n`);
        continue;
      }

      // Daemon only acts on signal / reaction events.
      if (evt?.kind !== "signal" && evt?.kind !== "reaction") continue;
      if (myAddress && evt.from_address === myAddress) continue;

      // Dedup: skip events whose signal has already been decided on.
      const eventId = evt.signal_id ?? evt.reaction_id;
      if (eventId && processed.has(eventId)) {
        process.stderr.write(`[daemon] stream: skipping already-processed ${evt.kind} ${eventId.slice(0, 8)}…\n`);
        continue;
      }

      handleEvent(evt, susu, provider, log, limiter, cfg, paperTrader).then(() => {
        // After successful decision, mark both IDs so subsequent
        // reactions to the same signal are skipped.
        if (evt.signal_id) processed.add(evt.signal_id);
        if (evt.reaction_id) processed.add(evt.reaction_id);
      }).catch((err) => {
        process.stderr.write(`[daemon] handle error: ${(err as Error)?.message ?? err}\n`);
      });
    }
  }
}

const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

async function handleEvent(
  evt: any,
  susu: SusuClientConfig,
  provider: LLMProvider,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  paperTrader: PaperTrader | null,
): Promise<void> {
  const decisionStartedAt = Date.now();

  // Skip expired signals — signals older than 1 hour are not actionable.
  // They remain in history as "missed" but the agent does not evaluate or act.
  if (evt.created_at) {
    const ageMs = Date.now() - new Date(evt.created_at).getTime();
    if (ageMs > SIGNAL_EXPIRY_MS) {
      const ageMin = Math.round(ageMs / 60_000);
      process.stderr.write(
        `[daemon] expired: ${evt.kind} ${(evt.signal_id ?? evt.reaction_id ?? "?").slice(0, 8)}… ` +
        `is ${ageMin}min old (>${Math.round(SIGNAL_EXPIRY_MS / 60_000)}min); skipped\n`,
      );
      reportDaemonDecision(susu, {
        kind: "error", error_type: "expired", event_kind: evt.kind,
        signal_id: evt.signal_id ?? undefined,
        context: { age_min: String(ageMin) },
      });
      return;
    }
  }

  if (!limiter.tryConsume()) {
    process.stderr.write(`[daemon] rate-limited (>${cfg.agent.max_calls_per_minute}/min); skipping event\n`);
    reportDaemonDecision(susu, {
      kind: "error", error_type: "rate_limited", event_kind: evt.kind,
      latency_ms: Date.now() - decisionStartedAt,
    });
    return;
  }
  // Normalize signal payload before LLM and paper trading see it.
  if (evt.payload && typeof evt.payload === "object") {
    const { payload: normalized, warnings } = normalizeSignalPayload(evt.payload as Record<string, unknown>);
    evt = { ...evt, payload: normalized };
    for (const w of warnings) {
      process.stderr.write(`[daemon] signal normalize warn: ${w}\n`);
    }
  }

  const channelId = evt.channel_id;
  const channelLabel = evt.channel_name ?? (evt.peer?.username ? `@${evt.peer.username}` : channelId.slice(0, 8));

  // Pull recent context for the LLM. Bounded by cfg.history_per_channel.
  let history: any[] = [];
  try {
    const r = await recentSignals(susu, channelId, cfg.agent.history_per_channel);
    history = r.signals ?? [];
  } catch { /* if history fetch fails, run with empty context */ }

  const ctx: AgentContext = {
    recent_events: history,
    channel_label: channelLabel,
    triggering_event: evt,
    my_handle: null,  // filled by main(); could thread through but UI shows from_username already
  };

  // ── LLM auth error cooldown ──────────────────────────────────────────
  if (llmAuthPausedUntil > Date.now()) {
    // Silently skip — banner already printed, waiting for cooldown.
    reportDaemonDecision(susu, { kind: "error", error_type: "llm_paused", event_kind: evt.kind });
    return;
  }

  let decision: AgentDecision;
  let stats;
  try {
    const out = await provider.decide(ctx, cfg.agent.system_prompt);
    decision = out.decision;
    stats = out.stats;
    // Success → reset auth error counter.
    if (llmAuthErrorCount > 0) {
      process.stderr.write(`[daemon] ✅ LLM recovered after ${llmAuthErrorCount} auth errors\n`);
      llmAuthErrorCount = 0;
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    process.stderr.write(`[daemon] LLM error: ${msg}\n`);
    reportClientError(susu, "llm_error", msg, { provider: cfg.llm.provider ?? "unknown" });

    if (isLlmAuthError(msg)) {
      llmAuthErrorCount++;
      if (llmAuthErrorCount >= LLM_AUTH_PAUSE_THRESHOLD) {
        process.stderr.write(`\n${"═".repeat(60)}\n`);
        process.stderr.write(`  ❌ LLM API KEY ERROR — ${llmAuthErrorCount} consecutive failures\n\n`);
        process.stderr.write(`  Your LLM API key is invalid or expired.\n`);
        process.stderr.write(`  Daemon will pause LLM calls for ${LLM_AUTH_PAUSE_SECONDS / 60} minutes.\n\n`);
        process.stderr.write(`  To fix:\n`);
        process.stderr.write(`    1. Check your API key at your LLM provider's dashboard\n`);
        process.stderr.write(`    2. Update ~/.susu/agent-config.json → llm.api_key\n`);
        process.stderr.write(`    3. Restart the daemon\n`);
        process.stderr.write(`${"═".repeat(60)}\n\n`);
        llmAuthPausedUntil = Date.now() + LLM_AUTH_PAUSE_SECONDS * 1000;
      }
    } else if (isLlmQuotaError(msg)) {
      process.stderr.write(`\n${"═".repeat(60)}\n`);
      process.stderr.write(`  ⚠️  LLM QUOTA EXCEEDED\n\n`);
      process.stderr.write(`  Your LLM API quota is exhausted. Check your billing at\n`);
      process.stderr.write(`  your provider's dashboard. Daemon will retry in ${LLM_AUTH_PAUSE_SECONDS / 60} min.\n`);
      process.stderr.write(`${"═".repeat(60)}\n\n`);
      llmAuthPausedUntil = Date.now() + LLM_AUTH_PAUSE_SECONDS * 1000;
    }
    const errType = isLlmAuthError(msg) ? "llm_auth_error" : isLlmQuotaError(msg) ? "llm_quota_error" : "llm_error";
    reportDaemonDecision(susu, {
      kind: "error",
      error_type: errType,
      event_kind: evt.kind,
      latency_ms: Date.now() - decisionStartedAt,
      context: { provider: cfg.llm.provider ?? "unknown" },
    });
    return;
  }

  // Execute the decision.
  let result: { id: string; cost_usd: number } | undefined;
  let error: string | undefined;
  try {
    if (decision.kind === "react") {
      const r = await pushReaction(susu, decision.signal_id, decision.payload, true);
      result = { id: r.reaction_id, cost_usd: r.cost_usd };
    } else if (decision.kind === "push") {
      if (cfg.dry_run_pushes) {
        error = "dry_run_pushes=true — push decision NOT executed (would have posted to channel)";
      } else {
        const r = await pushSignal(susu, decision.channel_id, decision.payload);
        result = { id: r.signal_id, cost_usd: r.cost_usd };
      }
    }
    // noop → nothing to execute
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  await log.log({ ctx, decision, stats, result, error });

  // Fire-and-forget decision telemetry — lets backend distinguish
  // "silent daemon" (running but all noop) vs "dead daemon" (not connected).
  // Phase 11b — also writes plaintext to /daemon_decisions for cross-device
  // user-visible decision history.
  // Phase 14 G #1 — reasoning_summary is OPT-IN via cfg.share_reasoning_summary.
  // Default false: only metadata + kind shared; LLM `note` stays local.
  // True: daemon uploads note (capped 500 chars, secrets redacted server-side).
  const decisionAny = decision as any;
  const reasoningSummary: string | undefined = cfg.share_reasoning_summary
    ? (typeof decisionAny?.payload?.note === "string" ? decisionAny.payload.note :
       typeof decisionAny?.note === "string" ? decisionAny.note :
       typeof decisionAny?.reasoning === "string" ? decisionAny.reasoning :
       undefined)
    : undefined;
  const reactionId = (result as any)?.reaction_id ?? undefined;
  reportDaemonDecision(susu, {
    kind: error ? "error" : decision.kind,
    signal_id: decision.kind === "react" ? decision.signal_id :
               (evt.kind === "signal" && (evt as any).signal_id) ? (evt as any).signal_id : undefined,
    channel_id: (evt as any).channel_id,
    reaction_id: reactionId,
    event_kind: evt.kind,
    error_type: error ? "execute_failed" : undefined,
    latency_ms: Date.now() - decisionStartedAt,
    llm_provider: cfg.llm.provider,
    llm_model: cfg.llm.model,
    reasoning_summary: reasoningSummary,  // undefined when opt-out
    context: {
      provider: cfg.llm.provider ?? "unknown",
      model: cfg.llm.model ?? "unknown",
    },
  });

  // Built-in paper trading (in-process, zero overhead).
  // When the trigger is a reaction, paper trader needs the original signal's
  // payload (token, entry_price, sl, tp, etc.), not the reaction's payload.
  if (paperTrader && !error) {
    let signalPayload: Record<string, unknown> | undefined;
    if (evt.kind === "reaction" && evt.signal_id && history.length > 0) {
      // Channel history API (/channels/{id}/signals) only returns signals
      // (no reactions) and omits the `kind` field — match by signal_id only.
      const orig = history.find((h: any) => h.signal_id === evt.signal_id);
      if (orig?.payload && typeof orig.payload === "object") {
        const { payload: normalized } = normalizeSignalPayload(orig.payload as Record<string, unknown>);
        signalPayload = normalized;
      }
    }
    paperTrader.onDecision(decision, evt, signalPayload);
  }

  // Optional on_decision hook for power users bridging external systems.
  // Fire-and-forget: daemon does not wait. Timeout kills after 30s.
  if (cfg.on_decision) {
    try {
      const hookPayload = JSON.stringify({
        decision, trigger: evt,
        result: result ?? null, error: error ?? null, stats: stats ?? null,
      });
      const child = spawn("sh", ["-c", cfg.on_decision], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.stdin!.write(hookPayload);
      child.stdin!.end();
      // Kill after 30s to prevent zombie processes.
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 30_000);
      child.on("exit", () => clearTimeout(killTimer));
      let stderrBuf = "";
      child.stderr!.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on("exit", (code) => {
        if (code !== 0 && stderrBuf) {
          process.stderr.write(`[daemon] on_decision hook exit=${code}: ${stderrBuf.slice(0, 300)}\n`);
        }
      });
    } catch (hookErr) {
      process.stderr.write(`[daemon] on_decision hook error: ${(hookErr as Error)?.message ?? hookErr}\n`);
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`[daemon] fatal: ${(err as Error)?.message ?? err}\n`);
  process.exit(1);
});
