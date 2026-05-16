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
import { IdeAgentRunner, commandOnPath, type AgentRunnerConfig, type RunnerInvocation, type RunnerResult } from "./agent_runner.ts";
import { DecisionLog } from "./decision_log.ts";
import { PaperTrader } from "./paper_trading.ts";
import { LivePositionMonitor } from "./live_monitor.ts";
import { normalizeSignalPayload } from "./normalize.ts";
import {
  pushSignal, pushReaction, recentSignals, feedSince,
  reportClientError, reportDaemonDecision, DAEMON_VERSION,
  type SusuClientConfig,
} from "./susu_actions.ts";
import { startLocalServer, type LocalServerConfig } from "./local_server.ts";

// ── Config ───────────────────────────────────────────────────────────────

interface DaemonConfig {
  api_url: string;
  token: string;
  /** Phase 18 — Susurration daemon delegates decisions to the user's IDE
   *  agent CLI (Claude Code / Codex / etc.). The daemon never calls LLM
   *  SDKs directly; that violates the product thesis (user's agent, not
   *  daemon's agent). See ADRs/2026-05-16-agent-daemon-ide-runner.md. */
  agent_runner: {
    /** CLI binary on PATH, e.g. "claude" / "codex". */
    command: string;
    /** Static args passed before the prompt. e.g. ["-p"] for claude headless. */
    args?: string[];
    /** Working directory for the spawned CLI. Defaults to $HOME so the
     *  user's global CLAUDE.md / MCP config / skills load. */
    cwd?: string;
    /** Timeout per event. Defaults to 90s. */
    timeout_ms?: number;
    /** Restrict tools (forwarded as --allowed-tools to Claude Code). For
     *  daemon mode we recommend "mcp__susurration__*" so the agent can
     *  only touch the network, not the user's filesystem. */
    allowed_tools?: string[];
    /** Per-event budget cap. Forwarded as --max-budget-usd. */
    max_budget_usd?: number;
  };
  agent: {
    /** Per-minute invocation cap. Protects the user's IDE subscription
     *  quota — has nothing to do with LLM API rate limits anymore.
     *  Defaults to 10. */
    max_calls_per_minute?: number;
    /** How many recent events to include in context. Defaults to 20. */
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
  /** Phase 15 — Privacy opt-out (was opt-in in Phase 14, flipped per Haze
   *  product decision: cross-device decision history is too useful to leave
   *  off by default).
   *  When TRUE (DEFAULT), daemon uploads its LLM decision `note` (capped
   *  500 chars, secrets redacted) to server's `daemon_decisions` table.
   *  Lets you see decision history on any device's dashboard.
   *  When FALSE, only react/push/noop metadata is shared (kind, signal_id,
   *  latency); the LLM reasoning stays local in agent-decisions.jsonl.
   *  Set to false if you want to keep your LLM reasoning fully local. */
  share_reasoning_summary?: boolean;
  /** Phase 17 — local HTTP server for one-click self-upgrade.
   *  Bound to 127.0.0.1:7777 by default. Disable by setting `{disabled:true}`
   *  or by setting `local_server: false`. */
  local_server?: LocalServerConfig | false;
  /** Phase 18.2 — interval in ms between live-position monitor ticks. Each
   *  tick is a GET (cheap); if any live positions are open, the agent is
   *  spawned to reconcile them against the broker MCP. Spawn = real money,
   *  so default is 30 min. Power users with active live trading + cheap
   *  IDE subs can lower; users with no live positions can leave alone
   *  (ticks are no-ops). Min ~60s enforced inside the monitor. */
  live_monitor_interval_ms?: number;
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

  // Phase 18 — instantiate IDE-agent runner. The user's IDE-agent CLI
  // (Claude Code / Codex / etc.) is the decider; daemon dispatches events
  // to it. Refuse to start if the configured CLI isn't on PATH — silent
  // fallback to LLM SDK would let the thesis drift.
  if (!commandOnPath(cfg.agent_runner.command)) {
    process.stderr.write(
      `[daemon] FATAL: configured agent runner '${cfg.agent_runner.command}' is not on PATH.\n` +
      `         Install it (e.g. \`npm install -g @anthropic-ai/claude-code\`) and re-run.\n`,
    );
    return 1;
  }
  const runnerCfg: AgentRunnerConfig = {
    command: cfg.agent_runner.command,
    args: cfg.agent_runner.args ?? [],
    cwd: cfg.agent_runner.cwd,
    timeout_ms: cfg.agent_runner.timeout_ms,
    allowed_tools: cfg.agent_runner.allowed_tools,
    max_budget_usd: cfg.agent_runner.max_budget_usd,
  };
  const runner = new IdeAgentRunner(runnerCfg);

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
  // Phase 11a + Phase 17.5 — startup sync from server (open + closed history).
  // We AWAIT this so trackPositions() doesn't tick on a partially-merged book.
  // Then flush any pending close-queue entries left from prior daemon runs
  // (close happened locally, sync failed, daemon crashed).
  if (paperTrader) {
    await paperTrader.syncFromServerOnce();
    const flushResult = await paperTrader.closeQueue.flush();
    if (flushResult.tried > 0) {
      process.stderr.write(
        `[daemon] startup close-queue flush: tried=${flushResult.tried} ` +
        `ok=${flushResult.ok} failed=${flushResult.failed} stale=${flushResult.stale}\n`,
      );
    }
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
    `runner=${cfg.agent_runner.command}, ` +
    `dry_run_pushes=${cfg.dry_run_pushes}` +
    `${paperTrader ? ", paper_trading=on" : ""}` +
    `, cap=${cfg.agent.max_calls_per_minute}/min\n`,
  );

  if (args.once) {
    return await runOncePoll(susu, runner, log, limiter, cfg, myAddress, myHandle, paperTrader);
  }

  // ── PID file + graceful shutdown ──────────────────────────────────────
  const pidPath = join(process.env.HOME ?? ".", ".susu", "agent-daemon.pid");
  await mkdir(dirname(pidPath), { recursive: true });
  const ownPid = String(process.pid);
  await writeFile(pidPath, ownPid, "utf8");
  // Phase 18.2-w — only unlink the pid file if it still belongs to US. During
  // upgrade handoff the new daemon spawns + writes its own PID to the same
  // path BEFORE the old daemon's process.on("exit") cleanup fires; a naïve
  // unlinkSync would delete the new daemon's pid file, breaking any external
  // tool (susu cli, monitoring scripts) that looks daemon up by pid.
  const cleanupPid = () => {
    try {
      const current = readFileSync(pidPath, "utf8").trim();
      if (current === ownPid) unlinkSync(pidPath);
    } catch {
      // file already gone, or unreadable — nothing to do.
    }
  };
  process.on("exit", cleanupPid);

  // Phase 18.2 — periodic live-position monitor. Cheap when there are no open
  // live positions on the server (just a GET); spawns the user's IDE-agent
  // every interval when there ARE live positions, so the agent can reconcile
  // them against the broker MCP and close any the broker has filled out.
  // Interval is intentionally long (30 min by default) — each tick that hits
  // the agent costs real money (claude / codex run), and live trades don't
  // change second-to-second from susurration's perspective. Power users can
  // tighten via agent-config (cfg.live_monitor_interval_ms). Declared before
  // gracefulStop so the closure can reference it.
  const liveMonitor = new LivePositionMonitor(
    susu,
    runner,
    cfg.live_monitor_interval_ms ?? undefined,
  );

  // Phase 18.2-w — gracefulStop is async + idempotent so the upgrade handoff
  // (local_server orchestrateHandoff) can AWAIT clean shutdown before
  // process.exit. Without this, an upgrade-triggered stop returned synchronously
  // while PaperTrader's in-flight trackPositions tick was still racing — close
  // decisions made in memory but not yet enqueued got lost when the old
  // daemon exited. paperTrader.stopTracking + liveMonitor.stop now await any
  // running tick to fully persist (or skip) before resolving.
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  const abortCtl = new AbortController();
  const gracefulStop = (sig: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    abortCtl.abort();
    process.stderr.write(`\n[daemon] stopping (${sig})\n`);
    stopPromise = (async () => {
      const tasks: Promise<unknown>[] = [];
      if (paperTrader) {
        try { tasks.push(paperTrader.stopTracking()); } catch (e) {
          process.stderr.write(`[daemon] paperTrader.stopTracking threw: ${(e as Error)?.message ?? e}\n`);
        }
      }
      try { tasks.push(liveMonitor.stop()); } catch (e) {
        process.stderr.write(`[daemon] liveMonitor.stop threw: ${(e as Error)?.message ?? e}\n`);
      }
      // Hard ceiling so a hung subsystem can't block exit forever. paper
      // tick should finish in <2s normally (one fetchPrices + a couple of
      // file writes); live monitor tick can take up to runner.timeout_ms
      // (90s) if mid-spawn — we cap at 5s and let it die with the process.
      const HARD_TIMEOUT_MS = 5_000;
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise<void>((resolve) => setTimeout(resolve, HARD_TIMEOUT_MS)),
      ]);
      process.stderr.write(`[daemon] graceful shutdown drained\n`);
    })();
    return stopPromise;
  };
  // Avoid unused-variable lint if `stopped` is only set above.
  void stopped;
  process.on("SIGINT", () => { void gracefulStop("SIGINT"); });
  process.on("SIGTERM", () => { void gracefulStop("SIGTERM"); });

  // Phase 17 — local HTTP server for one-click self-upgrade.
  // Disabled iff cfg.local_server === false. Otherwise starts on 127.0.0.1:7777.
  if (cfg.local_server !== false && args.config) {
    startLocalServer(cfg.local_server === undefined ? undefined : cfg.local_server, {
      bearerToken: cfg.token,
      configPath: args.config,
      gracefulStop: async () => { await gracefulStop("UPGRADE"); },
    });
  }

  // Start paper trading position tracker (60s interval) + live monitor.
  if (paperTrader) paperTrader.startTracking();
  liveMonitor.start();

  // Phase 17 — Push config snapshot to backend so the web dashboard's "Agent
  // state" panel can render real values (provider, execution mode, broker,
  // size gate) instead of "—". Done on startup + every 30 minutes. Failures
  // are non-fatal: dashboard will just show stale data until next ping.
  const daemonStartedAt = new Date().toISOString();
  async function pingConfigSnapshot() {
    try {
      const body = {
        // Phase 18 — provider is now the IDE-agent runner identity, not an
        // LLM model name. Daemon doesn't call LLMs directly anymore.
        provider: cfg.agent_runner.command,
        // null when paper trading is off — backend renders "—" rather than
        // showing stale "paper" (G review #3).
        execution_mode: cfg.paper_trading?.enabled ? "paper" : null,
        broker_connected: false, // no broker integration in v0.0.x
        // conv_threshold is set inside the user's CLAUDE.md / agent prompt;
        // daemon no longer owns it. Always null.
        conv_threshold: null,
        // Daemon's `min_size_factor` is the floor below which the daemon won't
        // open. Backend column name matches this semantic (G review #4).
        min_size_factor: cfg.paper_trading?.min_size_factor ?? null,
        daemon_started_at: daemonStartedAt,
      };
      await fetch(susu.api_url.replace(/\/$/, "") + "/identity/daemon-ping", {
        method: "POST",
        headers: {
          authorization: `Bearer ${susu.token}`,
          "content-type": "application/json",
          "user-agent": `susurration-agent-daemon/${DAEMON_VERSION}`,
        },
        body: JSON.stringify(body),
      });
    } catch { /* non-fatal */ }
  }
  pingConfigSnapshot();
  const configPingInterval = setInterval(pingConfigSnapshot, 30 * 60 * 1000);
  process.on("exit", () => clearInterval(configPingInterval));

  // Reconnect loop: same exponential backoff pattern as cli watch.
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;
  while (!stopped) {
    const startedAt = Date.now();
    try {
      await runOneStream(susu, runner, log, limiter, cfg, myAddress, myHandle, paperTrader, abortCtl.signal);
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

  // Cleanup. await so any in-flight tick finishes before we return — this
  // path is the natural stream-end (rare; usually SIGINT/SIGTERM beats it).
  if (paperTrader) await paperTrader.stopTracking();
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
  runner: IdeAgentRunner,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myAddress: string | null,
  myHandle: string | null,
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
      await handleEvent(evt, susu, runner, log, limiter, cfg, myHandle, paperTrader);
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
// Phase 18 — Auth pause logic deleted with LLM SDK. The IDE-agent CLI
// handles its own auth (Claude subscription / Codex login / etc.), and
// when it fails the daemon sees a non-zero exit code which is logged
// per-event without global pause semantics.

async function runOneStream(
  susu: SusuClientConfig,
  runner: IdeAgentRunner,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myAddress: string | null,
  myHandle: string | null,
  paperTrader: PaperTrader | null,
  signal?: AbortSignal,
): Promise<void> {
  const url = susu.api_url.replace(/\/$/, "") + "/signals/feed/stream";
  // Phase 16 — User-Agent reports daemon version so backend can update
  // identity.last_daemon_version for dashboard upgrade banner.
  const resp = await fetch(url, {
    headers: {
      authorization: `Bearer ${susu.token}`,
      "user-agent": `susurration-agent-daemon/${DAEMON_VERSION}`,
    },
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

      handleEvent(evt, susu, runner, log, limiter, cfg, myHandle, paperTrader).then(() => {
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
  runner: IdeAgentRunner,
  log: DecisionLog,
  limiter: MinuteRateLimiter,
  cfg: DaemonConfig,
  myHandle: string | null,
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

  const inv: RunnerInvocation = {
    recent_events: history,
    channel_label: channelLabel,
    triggering_event: evt,
    my_handle: myHandle,
  };

  // Phase 18 — dispatch to the user's IDE-agent CLI. The agent acts via
  // the @susurration/mcp tools it has mounted; this daemon process just
  // spawns + waits. Cost / auth / quota are the IDE-agent's concern, not
  // ours. Any non-zero exit is logged per-event without global pause.
  let runResult: RunnerResult;
  try {
    runResult = await runner.invoke(inv);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    process.stderr.write(`[daemon] runner spawn failed: ${msg}\n`);
    reportClientError(susu, "runner_error", msg, { runner: cfg.agent_runner.command });
    reportDaemonDecision(susu, {
      kind: "error",
      error_type: "runner_spawn_failed",
      event_kind: evt.kind,
      latency_ms: Date.now() - decisionStartedAt,
      context: { runner: cfg.agent_runner.command },
    });
    return;
  }

  if (!runResult.ok) {
    process.stderr.write(
      `[daemon] runner exit=${runResult.exit_code} dur=${runResult.duration_ms}ms\n` +
      `         stderr: ${runResult.stderr_tail.slice(-400)}\n`,
    );
    reportClientError(susu, "runner_error",
      `exit ${runResult.exit_code}: ${runResult.stderr_tail.slice(-200)}`,
      { runner: cfg.agent_runner.command },
    );
    reportDaemonDecision(susu, {
      kind: "error",
      error_type: runResult.exit_code == null ? "runner_timeout" : "runner_failed",
      event_kind: evt.kind,
      latency_ms: runResult.duration_ms,
      context: { runner: cfg.agent_runner.command, exit_code: String(runResult.exit_code) },
    });
    return;
  }

  // Log the invocation. The actual decision (react / push / noop) lives in
  // the backend now — the IDE-agent acted directly via susu_* MCP tools.
  // Daemon records "invocation done" with prompt + stdout for audit.
  await log.log({
    triggering_event: evt,
    invocation: {
      runner: cfg.agent_runner.command,
      duration_ms: runResult.duration_ms,
      exit_code: runResult.exit_code,
    },
    stdout_tail: runResult.stdout_tail.slice(-1000),
  });

  // Decision telemetry for cross-device visibility. We can't introspect what
  // the IDE-agent decided locally — its action shows up on the backend via
  // /signals/:id/reactions or /channels/:id/signals (whichever it called).
  // Mark this as `invoke` kind so the dashboard knows the daemon dispatched
  // an event even when the agent chose to do nothing.
  reportDaemonDecision(susu, {
    kind: "invoke",
    signal_id: evt.kind === "signal" ? (evt as any).signal_id : undefined,
    channel_id: (evt as any).channel_id,
    event_kind: evt.kind,
    latency_ms: runResult.duration_ms,
    context: {
      runner: cfg.agent_runner.command,
      exit_code: String(runResult.exit_code),
    },
  });

  // Phase 18.2 — auto-open is server-atomic now. When the agent calls
  // susu_signal_accept (mcp-adapter), backend's /signals/:id/accept handler
  // writes the reaction row AND the positions row in one transaction. The
  // daemon does not need to react to its own decisions; paperTrader still
  // owns the close side (SL / TP / trailing / time stop on the local price
  // feed, mirroring closes to /positions/close). paperTrader.syncFromServer
  // pulls newly-opened positions on the next track tick so price tracking
  // engages without any extra wiring here.
  void paperTrader;

  // Optional on_decision hook for power users bridging external systems.
  // Fire-and-forget: daemon does not wait. Timeout kills after 30s.
  if (cfg.on_decision) {
    try {
      const hookPayload = JSON.stringify({
        invocation: { runner: cfg.agent_runner.command, exit_code: runResult.exit_code, duration_ms: runResult.duration_ms },
        trigger: evt,
        stdout_tail: runResult.stdout_tail.slice(-400),
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
