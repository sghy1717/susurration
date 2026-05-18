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
  // 2026-05-18 ADR remove-platform-paternalism: allowed_tools and
  // max_budget_usd removed. Agent capability is fully owned by the user's
  // IDE permission system (~/.claude/settings.json); per-event cost is
  // owned by the user's IDE subscription. Susurration is communication
  // layer only — doesn't gate capability or meter spend.
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

/** One tool call captured from the claude `--output-format stream-json` stream.
 *  2026-05-18 ADR remove-platform-paternalism §What we add #9 — used for the
 *  user's local dashboard to surface "agent called Read(Sbrain/...) +
 *  mcp__gmgn-token__... + reasoned with Skill X" so thesis ("调用用户 agent
 *  能力") is visible. STAYS LOCAL — never push to peer. */
export interface ToolUse {
  /** Tool name as the IDE-agent reports it. e.g. "Read", "Skill",
   *  "mcp__susurration__susu_signal_accept", "WebFetch". */
  name: string;
  /** Tool input as recorded by the IDE-agent. Shape depends on the tool.
   *  Kept as unknown — dashboard renders a JSON preview; we don't model
   *  every tool's schema. */
  input: unknown;
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
  /** Tool calls extracted from claude stream-json `assistant` events.
   *  Empty array when present-but-none; undefined when the runner doesn't
   *  emit stream-json (e.g. codex — future ADR). Local-only. */
  tools_used?: ToolUse[];
  /** Concatenated text from claude stream-json `assistant` content blocks
   *  (type=text). The agent's own narrated reasoning between tool calls.
   *  Local-only. */
  reasoning?: string;
  /** Permission denials reported by claude in the final `result` event —
   *  IDE-side denials of tool calls. Signals the user's permission system
   *  did its job; daemon does not interpret these. Local-only. */
  permission_denials?: unknown[];
  /** Total cost from claude's `result.total_cost_usd`. Logged for the
   *  user's own bookkeeping — Susurration does not gate on it (ADR §What
   *  we remove). Local-only. */
  cost_usd?: number;
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
      "Your capabilities (tools / Skills / MCPs / Read access / etc.) are",
      "whatever your IDE permission system grants for this -p invocation.",
      "Susurration does not gate or limit them — if a tool is in your tool",
      "list, you may use it. If a destructive action would normally need",
      "user confirmation and you can't ask (you're running headless), treat",
      "that as a hard 'no' and fall through to branch C or D.",
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
      "           literal token `SUSURRATION_LIVE_OK`. If you do NOT have a",
      "           filesystem Read tool available, you cannot verify (2) —",
      "           fall through. Do NOT infer authorisation from vibes.",
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

    // Build the arg list.
    // 2026-05-18 ADR remove-platform-paternalism:
    //   --allowed-tools and --max-budget-usd are NOT appended. Agent
    //   capability and per-event spend are owned by the user's IDE
    //   permission system + IDE subscription. Susurration is communication
    //   layer only — see ADRs/2026-05-18-remove-platform-paternalism.md.
    //
    // 2026-05-18 G review P0 #1 — prompt no longer passed as positional
    // argv. The prompt contains the full triggering_event JSON +
    // recent_events JSON (channel context, peer signal payloads, position
    // snapshots). Argv is world-readable via `ps aux` on macOS/Linux —
    // every same-machine user/process could read every peer signal that
    // hit the daemon. We now write the prompt to the child's stdin and
    // claude `-p` consumes stdin when no positional prompt is supplied
    // (verified empirically: `echo "X" | claude -p` returns the answer).
    // Same path also dodges OS ARG_MAX limits (macOS 1MB / Linux 256KB)
    // that would silently E2BIG on big recent_events history.
    const args = [...this.cfg.args];

    return new Promise<RunnerResult>((resolve) => {
      // 2026-05-18 ADR §What we add #9 — streaming NDJSON parser.
      //   Claude `--output-format stream-json` outputs newline-delimited
      //   JSON events. We parse line-by-line as chunks arrive (so memory
      //   stays bounded even for long agent runs that emit MB of stream)
      //   and accumulate tool_use + text + result fields locally.
      //   LOCAL ONLY — never push to peer.
      let stdoutLineBuf = "";          // current incomplete line for parser
      let stdoutTailBuf = "";          // last STDOUT_CAP bytes for diagnostics
      let stderrBuf = "";
      let exited = false;

      const toolsUsed: ToolUse[] = [];
      const reasoningParts: string[] = [];
      let permissionDenials: unknown[] | undefined;
      let costUsd: number | undefined;

      const consumeLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: any;
        try { evt = JSON.parse(trimmed); } catch { return; }
        if (evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
          for (const block of evt.message.content) {
            if (block?.type === "tool_use" && typeof block.name === "string") {
              toolsUsed.push({ name: block.name, input: block.input });
            } else if (block?.type === "text" && typeof block.text === "string") {
              reasoningParts.push(block.text);
            }
          }
        } else if (evt?.type === "result") {
          if (Array.isArray(evt.permission_denials)) permissionDenials = evt.permission_denials;
          if (typeof evt.total_cost_usd === "number") costUsd = evt.total_cost_usd;
        }
      };

      const buildParseResult = (): Pick<RunnerResult, "tools_used" | "reasoning" | "permission_denials" | "cost_usd"> => {
        // Drain any trailing partial line (claude usually ends with \n,
        // but defend against the edge case).
        if (stdoutLineBuf) {
          consumeLine(stdoutLineBuf);
          stdoutLineBuf = "";
        }
        return {
          tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
          reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n").trim() : undefined,
          permission_denials: permissionDenials,
          cost_usd: costUsd,
        };
      };

      let child;
      try {
        child = spawn(this.cfg.command, args, {
          cwd: this.cfg.cwd ?? process.env.HOME ?? ".",
          // G review P0 #1 — stdin pipe so we can write the prompt
          // instead of leaking it via argv. See `args` comment above.
          stdio: ["pipe", "pipe", "pipe"],
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

      // G review P0 #1 — write the prompt via stdin (was: positional argv).
      // Error path: if stdin write fails (rare — broken pipe if child
      // exits before we finish writing), we'll see exit_code != 0 below
      // and the outer caller logs it. Don't crash the daemon on a child
      // process accident.
      try {
        child.stdin!.write(prompt);
        child.stdin!.end();
      } catch (e) {
        process.stderr.write(`[daemon] stdin write failed: ${(e as Error)?.message ?? String(e)}\n`);
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        // Line-by-line NDJSON parser. Stream may split a single event
        // across chunks, so we accumulate until we see a newline.
        stdoutLineBuf += s;
        let nl: number;
        while ((nl = stdoutLineBuf.indexOf("\n")) >= 0) {
          const line = stdoutLineBuf.slice(0, nl);
          stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
          consumeLine(line);
        }
        // Maintain a sliding tail for diagnostics (last STDOUT_CAP bytes
        // of raw stdout). The old behaviour kept the *head* despite the
        // field being named `stdout_tail` — fixed here.
        stdoutTailBuf = (stdoutTailBuf + s).slice(-STDOUT_CAP);
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
          stdout_tail: stdoutTailBuf,
          prompt,
          ...buildParseResult(),
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
          stdout_tail: stdoutTailBuf,
          prompt,
          ...buildParseResult(),
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
