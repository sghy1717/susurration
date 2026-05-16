// Phase 18 — IDE-agent runner.
//
// Replaces the LLM SDK call path (deleted llm.ts). Susurration's product
// thesis says decisions belong to the user's agent — the agent running
// inside their IDE (Claude Code / Codex / etc.) with their CLAUDE.md, their
// MCP servers, their skills, their memory. Daemon's job here is to spawn
// that CLI agent and let it act through the @susurration/mcp tools it
// already has mounted.
//
// See ADRs/2026-05-16-agent-daemon-ide-runner.md for the full decision.

import { spawn } from "node:child_process";

export interface AgentRunnerConfig {
  /** CLI binary name or absolute path. e.g. "claude" / "/usr/local/bin/codex". */
  command: string;
  /** Static args appended before the prompt. e.g. ["-p", "--output-format", "stream-json"]. */
  args: string[];
  /** Working directory for the child process. Determines which CLAUDE.md /
   *  user config loads. Default: user's $HOME. */
  cwd?: string;
  /** How long to wait for the agent CLI to exit. Default 90s. */
  timeout_ms?: number;
  /** Restrict the agent to susu_* tools so it can't go edit files / run
   *  shells on user's machine during automated daemon invocations.
   *  Forwarded as --allowed-tools (claude) when supported. */
  allowed_tools?: string[];
  /** Optional cost ceiling per event. Forwarded as --max-budget-usd when
   *  the runner supports it. */
  max_budget_usd?: number;
}

export interface RunnerInvocation {
  /** What triggered this invocation — passed verbatim into the prompt. */
  triggering_event: unknown;
  /** Last N events on the same channel for context. */
  recent_events: unknown[];
  /** Channel display label (peer @handle for DM, group name for group). */
  channel_label: string;
  /** Caller's own @handle so the agent doesn't react to its own pushes. */
  my_handle: string | null;
}

export interface RunnerResult {
  /** Did the CLI exit cleanly within the timeout? */
  ok: boolean;
  /** Exit code (null on timeout / spawn failure). */
  exit_code: number | null;
  /** Wall-clock time the CLI ran. */
  duration_ms: number;
  /** Captured stderr (truncated). Useful for debugging silent daemons. */
  stderr_tail: string;
  /** Captured stdout (truncated). Most action visibility comes from the
   *  backend (because the agent acts via susu_* MCP tools), but we keep
   *  stdout for diagnostics. */
  stdout_tail: string;
  /** What we asked the agent to do; logged for audit. */
  prompt: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const STDOUT_CAP = 8_000;
const STDERR_CAP = 4_000;

export class IdeAgentRunner {
  constructor(private cfg: AgentRunnerConfig) {}

  /** Build the prompt fed to the IDE-agent CLI. Short by design — the
   *  agent's own CLAUDE.md + skills + memory provide the rest of the
   *  context. */
  buildPrompt(inv: RunnerInvocation): string {
    return [
      "You are being invoked non-interactively by the Susurration agent-daemon.",
      "A peer in one of your channels just emitted a trading signal. Read it,",
      "evaluate it against your own judgement (your CLAUDE.md, your skills,",
      "your memory, any broker MCP tools the user has configured), and pick",
      "exactly one branch of the decision tree below. Conservative is safer;",
      "doing nothing is always allowed.",
      "",
      "Important: daemon dispatch defaults to `allowed-tools mcp__susurration__*`",
      "for safety, which means by default you do NOT have broker tools, file",
      "read, or shell access in this invocation. Live execution (branch B) is",
      "only reachable if the user has widened the allowed-tools in their",
      "agent-config to include broker + (optionally) Read. Until then, treat",
      "this loop as paper-only — branch A / C / D are your real options.",
      "",
      `Your handle on the network: ${inv.my_handle ?? "(unknown)"}`,
      `Channel: ${inv.channel_label}`,
      "",
      "Triggering event (the new thing — act on this):",
      "```json",
      JSON.stringify(inv.triggering_event, null, 2),
      "```",
      "",
      `Recent channel context (last ${inv.recent_events.length} events, orientation only):`,
      "```json",
      JSON.stringify(inv.recent_events, null, 2),
      "```",
      "",
      "Decision tree — pick ONE:",
      "",
      "  A. Accept (PAPER) — you would take this trade in simulation only.",
      "     Call `susu_signal_accept` with mode=\"paper\" and pricing fields",
      "     (entry_price, stop_loss, take_profit, position_usd, leverage,",
      "     direction, token) taken from the signal payload. Pick your own",
      "     size_factor in [0.3, 1.0] based on conviction. The server",
      "     atomically writes a +1 reaction and a paper-mode positions row.",
      "     The susurration daemon's PaperTrader will mark-to-market and",
      "     auto-close on SL / TP / trailing / time stop.",
      "",
      "  B. Accept (LIVE) — you would take this trade for real money. The",
      "     branch requires THREE concrete preconditions; do not enter it on",
      "     any softer signal:",
      "       (1) A broker tool is currently in your tool list with a name",
      "           matching `*place_order*` / `*submit_order*` / `*open_position*`.",
      "           No matching tool → branch B is impossible; fall through.",
      "       (2) The user's CLAUDE.md / project memory contains the explicit",
      "           literal token `SUSURRATION_LIVE_OK`. If you do NOT have",
      "           filesystem read in your allowed-tools, you cannot verify (2)",
      "           — fall through. Do NOT infer authorisation from vibes.",
      "       (3) The susurration server will REJECT mode=\"live\" without a",
      "           non-empty broker_position_id, so you must actually get a",
      "           fill from the broker before calling susu_signal_accept.",
      "     Then call:",
      "       broker_tool(...)  → get fill_price + broker_id",
      "       susu_signal_accept(mode=\"live\", entry_price=fill_price,",
      "                          broker_position_id=broker_id, ...)",
      "     If (1) (2) (3) aren't all true, fall back to branch A (paper)",
      "     or D (do nothing). NEVER fabricate broker_position_id or fill",
      "     price to make mode=\"live\" go through — the server's reject is a",
      "     guardrail, not an obstacle.",
      "",
      "  C. Reject — you reviewed and would NOT take this trade. Call",
      "     `susu_signal_reject` with a short note. No position is opened.",
      "     Use this when you want the peer to see you saw the signal but",
      "     declined; silent skip (branch D) is also fine.",
      "",
      "  D. Do nothing — the signal is malformed, off-topic, or your",
      "     conviction is too low to commit either way. Just exit without",
      "     calling any tool.",
      "",
      "Closing live positions (separate flow):",
      "  When the user's broker MCP tells you a previously-opened live",
      "  position has been filled out (manual close, stop hit, etc.), call",
      "  `susu_position_close` with the realised exit_price and pnl so the",
      "  susurration book reflects broker truth. Paper positions close",
      "  themselves; do NOT call susu_position_close on a paper position.",
      "",
      "Other tools available: `susu_signal_push` (emit your own alpha to the",
      "channel), `susu_signals_recent` (look up older events), `susu_signals",
      "_feed` (cross-channel inbox). Use sparingly during a daemon dispatch",
      "— the primary job for this invocation is one accept / reject / close",
      "/ noop call, then exit.",
    ].join("\n");
  }

  /** Spawn the agent with a "reconcile your open live positions against the
   *  user's broker MCP" prompt. Called from LivePositionMonitor on its
   *  periodic tick when there is at least one open live position on the
   *  server. The agent decides what to do — close any positions the broker
   *  has filled out via susu_position_close, leave the rest alone, exit. */
  async invokeLiveMonitor(openLivePositions: unknown[]): Promise<RunnerResult> {
    const prompt = this.buildLiveMonitorPrompt(openLivePositions);
    return await this.spawnAgentWithPrompt(prompt);
  }

  buildLiveMonitorPrompt(openLivePositions: unknown[]): string {
    return [
      "You are being invoked non-interactively by the Susurration agent-daemon",
      "on its periodic live-position monitor tick. The susurration server",
      "currently shows the following positions as OPEN in mode=\"live\" for you.",
      "Each one represents a real broker order that you (or a previous agent",
      "invocation) placed. The server doesn't know whether the broker has",
      "since filled or closed them — only your broker MCP does.",
      "",
      "Open live positions:",
      "```json",
      JSON.stringify(openLivePositions, null, 2),
      "```",
      "",
      "For each position, check your broker MCP (whichever tool your CLAUDE.md",
      "/ settings have configured) to see if the broker still shows it open.",
      "If the broker has closed it (manual close, SL/TP hit, liquidation,",
      "etc.), capture the realised exit price + pnl from the broker and call",
      "`susu_position_close` with that data so the susurration book matches",
      "broker truth.",
      "",
      "If you have no broker MCP configured, or you cannot determine the",
      "broker's current state for these positions, just exit — silent is fine.",
      "The monitor will tick again later.",
      "",
      "Do NOT touch any paper-mode positions; they're managed by the daemon's",
      "PaperTrader and you won't see them in the list above. Do NOT push new",
      "signals or react to anything during a monitor tick — the only valid",
      "action this invocation is susu_position_close calls.",
    ].join("\n");
  }

  async invoke(inv: RunnerInvocation): Promise<RunnerResult> {
    return await this.spawnAgentWithPrompt(this.buildPrompt(inv));
  }

  /** Shared spawn / capture / timeout core. Both event dispatch (invoke) and
   *  periodic live-position monitor (invokeLiveMonitor) call this — the only
   *  difference between them is the prompt body. */
  private async spawnAgentWithPrompt(prompt: string): Promise<RunnerResult> {
    const startedAt = Date.now();
    const timeout = this.cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Build the full arg list. The prompt is the last positional arg.
    const args = [...this.cfg.args];
    if (this.cfg.allowed_tools && this.cfg.allowed_tools.length > 0) {
      args.push("--allowed-tools", this.cfg.allowed_tools.join(","));
    }
    if (this.cfg.max_budget_usd != null) {
      args.push("--max-budget-usd", String(this.cfg.max_budget_usd));
    }
    args.push(prompt);

    return new Promise<RunnerResult>((resolve) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let exited = false;

      let child;
      try {
        child = spawn(this.cfg.command, args, {
          cwd: this.cfg.cwd ?? process.env.HOME ?? ".",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });
      } catch (e) {
        resolve({
          ok: false,
          exit_code: null,
          duration_ms: Date.now() - startedAt,
          stderr_tail: `spawn failed: ${(e as Error)?.message ?? String(e)}`,
          stdout_tail: "",
          prompt,
        });
        return;
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        if (stdoutBuf.length < STDOUT_CAP) {
          stdoutBuf += chunk.toString();
          if (stdoutBuf.length > STDOUT_CAP) stdoutBuf = stdoutBuf.slice(0, STDOUT_CAP);
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < STDERR_CAP) {
          stderrBuf += chunk.toString();
          if (stderrBuf.length > STDERR_CAP) stderrBuf = stderrBuf.slice(0, STDERR_CAP);
        }
      });

      const killTimer = setTimeout(() => {
        if (exited) return;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        // resolve will fire when child emits 'exit'
      }, timeout);

      child.on("error", (err) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        resolve({
          ok: false,
          exit_code: null,
          duration_ms: Date.now() - startedAt,
          stderr_tail: `spawn error: ${err.message}`,
          stdout_tail: stdoutBuf.slice(-STDOUT_CAP),
          prompt,
        });
      });

      child.on("exit", (code) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        const duration_ms = Date.now() - startedAt;
        const ok = code === 0;
        resolve({
          ok,
          exit_code: code,
          duration_ms,
          stderr_tail: stderrBuf.slice(-STDERR_CAP),
          stdout_tail: stdoutBuf.slice(-STDOUT_CAP),
          prompt,
        });
      });
    });
  }
}

/** Convenience: detect whether a runner command is on PATH. */
export function commandOnPath(cmd: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
