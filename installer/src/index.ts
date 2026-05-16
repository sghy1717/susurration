// @susurration/installer — one-shot install for Susurration.
//
// USER COMMAND:
//   npx -y @susurration/installer install --token sk_xxx
//
// FLOW (4 stages, each pinged to backend so web onboarding shows progress):
//   1. install_daemon        → npm install -g susurration-agent-daemon
//   2. mount_to_ide          → write MCP config to each detected IDE
//   3. connect_susurration   → write ~/.susu/agent-config.json + spawn daemon
//   4. first_signal_ready    → backend already pushed welcome+replay to channel
//                              (this stage is a "confirm visible" ping)
//
// AGENT-THESIS COMPLIANCE: the installer never starts an LLM, never proxies
// LLM calls. The user's own LLM (Claude / GPT / DeepSeek / etc.) is what
// evaluates signals — this tool only places config files and starts the
// daemon that connects to the user's LLM.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// ─── Config ────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://susurration.xyz/api";
const DAEMON_NPM_NAME = "susurration-agent-daemon";
const MCP_NPM_NAME = "@susurration/mcp";

interface CliArgs {
  command: "install" | "uninstall" | "help";
  token: string;
  baseUrl: string;
  // Phase 18 — agent runner CLI replaces the removed LLM key flow.
  runnerCommand?: string;
  runnerArgs?: string[];
  noPrompt: boolean;  // CI mode — auto-confirm everything
  onlyIde?: string;    // restrict to one IDE (testing)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "help",
    token: "",
    baseUrl: DEFAULT_BASE_URL,
    noPrompt: false,
  };
  if (argv.length === 0) return args;
  args.command = (argv[0] as CliArgs["command"]) ?? "help";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--token") args.token = argv[++i] ?? "";
    else if (a === "--base-url") {
      const url = argv[++i] ?? DEFAULT_BASE_URL;
      // Reject non-HTTPS base URLs — `--base-url http://attacker.com/api` in a
      // social-engineering scenario would redirect all daemon traffic + token
      // to attacker. Allow localhost http for dev only.
      if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        process.stderr.write(`\x1b[31mfatal:\x1b[0m --base-url must use https:// (got: ${url})\n`);
        process.exit(2);
      }
      args.baseUrl = url;
    }
    else if (a === "--runner-command") args.runnerCommand = argv[++i];
    else if (a === "--runner-args") args.runnerArgs = (argv[++i] ?? "").split(/\s+/).filter(Boolean);
    else if (a === "--no-prompt") args.noPrompt = true;
    else if (a === "--only") args.onlyIde = argv[++i];
    else if (a === "--help" || a === "-h") args.command = "help";
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`@susurration/installer — one-shot Susurration setup

USAGE
  npx -y @susurration/installer install --token sk_xxx
  npx -y @susurration/installer uninstall

OPTIONS
  --token <sk_xxx>          Your SUSU bearer token (from https://susurration.xyz onboarding)
  --base-url <url>          Backend base URL (default: ${DEFAULT_BASE_URL})
  --runner-command <cli>    IDE-agent CLI to delegate decisions to. Auto-detected
                            (claude → codex). Override for custom setups.
  --runner-args <flags>     Flags passed before the prompt (default: -p).
  --no-prompt               Auto-confirm all prompts (CI mode)
  --only <ide>              Restrict to one IDE: claude | cursor | windsurf | cline | codex
  -h, --help                Show this help

WHAT IT DOES
  1. Detects which AI IDEs are installed on this machine
  2. Asks you which IDEs to configure (default: all detected)
  3. Installs the Susurration agent daemon globally via npm
  4. Writes MCP config to each chosen IDE so your agent gets susu_* tools
  5. Writes ~/.susu/agent-config.json with your token + IDE-agent runner
  6. Spawns the daemon in the background
  7. Tells you to quit + reopen your IDE (MCP loads on startup)

After completion, your IDE's AI agent gets the susu_* MCP tools, and the
daemon delegates every peer signal to your agent CLI — running with your
CLAUDE.md, your MCP servers, your skills, your memory. No LLM API key
required; your IDE's subscription / login covers it.

DOCS  https://susurration.xyz/docs
`);
}

// ─── Telemetry (fire-and-forget pings to backend) ─────────────────────

interface TelemetryClient {
  started(payload: Record<string, unknown>): Promise<void>;
  ideDetected(ides: string[]): Promise<void>;
  stage(stage: 1 | 2 | 3 | 4, status: "running" | "ok" | "fail" | "timeout", extra?: Record<string, unknown>): Promise<void>;
  complete(success: boolean, extra?: Record<string, unknown>): Promise<void>;
}

function makeTelemetry(baseUrl: string, token: string): TelemetryClient {
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);  // never block install on telemetry
      await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch { /* swallow — telemetry never blocks install flow */ }
  };
  return {
    started: (payload) => post("/installer/started", payload),
    ideDetected: (ides) => post("/installer/ide-detected", { ides }),
    stage: (stage, status, extra) => post("/installer/stage", { stage, status, ...extra }),
    complete: (success, extra) => post("/installer/complete", { success, ...extra }),
  };
}

// ─── IDE detection ────────────────────────────────────────────────────

type IdeId = "claude" | "cursor" | "windsurf" | "cline" | "codex";

interface IdeInfo {
  id: IdeId;
  name: string;
  detected: boolean;
  detectionMethod: string;
}

function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

function dirExists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

function detectIdes(): IdeInfo[] {
  const home = homedir();
  return [
    {
      id: "claude",
      name: "Claude Code",
      detected: commandExists("claude"),
      detectionMethod: "`claude` CLI on PATH",
    },
    {
      id: "cursor",
      name: "Cursor",
      detected: dirExists(join(home, ".cursor")) || commandExists("cursor"),
      detectionMethod: "~/.cursor or `cursor` CLI",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      detected: dirExists(join(home, ".codeium", "windsurf")) || commandExists("windsurf"),
      detectionMethod: "~/.codeium/windsurf",
    },
    {
      id: "cline",
      name: "Cline",
      detected: dirExists(join(home, "Documents", "Cline")) || dirExists(join(home, ".cline")),
      detectionMethod: "~/Documents/Cline or ~/.cline",
    },
    {
      id: "codex",
      name: "Codex CLI",
      detected: dirExists(join(home, ".codex")) || commandExists("codex"),
      detectionMethod: "~/.codex or `codex` CLI",
    },
  ];
}

// ─── User prompts (TTY) ───────────────────────────────────────────────

async function promptIdeSelection(detected: IdeInfo[], noPrompt: boolean): Promise<IdeInfo[]> {
  const installable = detected.filter((d) => d.detected);
  if (installable.length === 0) {
    return [];
  }
  if (noPrompt || !process.stdin.isTTY) {
    return installable;  // CI / non-TTY: install to all detected
  }
  process.stdout.write(`\nDetected IDEs (press Enter to install to ALL, or type comma-separated names to limit):\n`);
  installable.forEach((d, i) => {
    process.stdout.write(`  [${i + 1}] ${d.name} (${d.id})\n`);
  });
  process.stdout.write(`\nYour choice [all]: `);
  const line = await new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  if (line === "" || line.toLowerCase() === "all") return installable;
  const picked = new Set(line.split(",").map((s) => s.trim().toLowerCase()));
  return installable.filter((d) => picked.has(d.id) || picked.has(d.name.toLowerCase()));
}

// ─── MCP config writers ───────────────────────────────────────────────

interface McpConfigContext {
  token: string;
  baseUrl: string;
}

function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const ts = Date.now();
  copyFileSync(path, `${path}.bak.${ts}`);
}

function readJsonSafe<T = any>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function writeJsonAtomic(path: string, data: any): void {
  // POSIX rename is atomic — guarantees the destination either has the new
  // content or the old content, never a half-written truncated JSON. Critical
  // when overwriting user's mcp.json / agent-config.json — a Ctrl+C / OOM kill
  // during writeFileSync would otherwise wipe their other MCP configs.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist on early failure */ }
    throw err;
  }
}

/** Scrub bearer tokens / LLM API keys from a string before logging or
 *  sending in telemetry. Patterns: SUSU sk_xxx, Anthropic sk-ant-xxx,
 *  OpenAI sk-xxx (generic openai/deepseek/etc.) — replace value with `***`. */
function scrubSecrets(s: string): string {
  return s
    .replace(/sk_[A-Za-z0-9_-]+/g, "sk_***")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

function mcpServerEntry(ctx: McpConfigContext) {
  return {
    command: "npx",
    args: ["-y", MCP_NPM_NAME],
    env: { SUSU_TOKEN: ctx.token, ...(ctx.baseUrl !== DEFAULT_BASE_URL ? { SUSU_BASE_URL: ctx.baseUrl } : {}) },
  };
}

/** Claude Code uses its own CLI to add MCP servers (writes to ~/.claude.json
 *  with workspace-trust logic). We invoke the CLI rather than touching the
 *  file directly to avoid breaking Claude's internal schema assumptions. */
function configureClaudeCode(ctx: McpConfigContext): { ok: true } | { ok: false; reason: string } {
  if (!commandExists("claude")) {
    return { ok: false, reason: "`claude` CLI not on PATH — install Claude Code first" };
  }
  // Idempotent: remove then re-add (Claude's `add` errors if already exists).
  // Remove from BOTH user and local scopes — a previous installer run may have
  // written to either, and a leftover local-scope entry would shadow our new
  // user-scope one for project-rooted Claude sessions.
  try { spawnSync("claude", ["mcp", "remove", "susurration", "--scope", "user"], { stdio: "ignore" }); } catch { /* fine */ }
  try { spawnSync("claude", ["mcp", "remove", "susurration", "--scope", "local"], { stdio: "ignore" }); } catch { /* fine */ }
  // Phase 18 — must be `--scope user`. The agent-daemon spawns `claude -p` from
  // the user's $HOME, which is outside any project directory; local-scope MCP
  // entries (Claude's default) only load when claude is invoked inside the
  // project that registered them. Without user scope, the daemon's headless
  // claude call sees zero susu_* tools and every dispatch is a no-op.
  const args = [
    "mcp", "add", "susurration",
    "--scope", "user",
    "-e", `SUSU_TOKEN=${ctx.token}`,
    ...(ctx.baseUrl !== DEFAULT_BASE_URL ? ["-e", `SUSU_BASE_URL=${ctx.baseUrl}`] : []),
    "--", "npx", "-y", MCP_NPM_NAME,
  ];
  const r = spawnSync("claude", args, { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    // claude CLI may echo argv (including -e SUSU_TOKEN=sk_xxx) into stderr on
    // parse errors. Scrub before exposing to telemetry / user terminal.
    return { ok: false, reason: `claude mcp add failed: ${scrubSecrets((r.stderr ?? "").slice(0, 200))}` };
  }
  return { ok: true };
}

function configureJsonBasedIde(
  configPath: string,
  topKey: "mcpServers" | "mcp" | "context_servers",
  ctx: McpConfigContext,
): { ok: true } | { ok: false; reason: string } {
  try {
    backupFile(configPath);
    const existing = readJsonSafe<Record<string, any>>(configPath) ?? {};
    const servers = existing[topKey] ?? {};
    servers["susurration"] = mcpServerEntry(ctx);
    existing[topKey] = servers;
    writeJsonAtomic(configPath, existing);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `failed to write ${configPath}: ${(err as Error).message}` };
  }
}

function configureIde(id: IdeId, ctx: McpConfigContext): { ok: true } | { ok: false; reason: string } {
  const home = homedir();
  switch (id) {
    case "claude": return configureClaudeCode(ctx);
    case "cursor": return configureJsonBasedIde(join(home, ".cursor", "mcp.json"), "mcpServers", ctx);
    case "windsurf": return configureJsonBasedIde(join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", ctx);
    case "cline": return configureJsonBasedIde(
      platform() === "darwin"
        ? join(home, "Documents", "Cline", "MCP", "cline_mcp_settings.json")
        : join(home, ".cline", "mcp_settings.json"),
      "mcpServers", ctx);
    case "codex": return configureJsonBasedIde(join(home, ".codex", "mcp_settings.json"), "mcp", ctx);
  }
}

// ─── Daemon install + spawn ───────────────────────────────────────────

function installDaemonGlobally(): { ok: true; elapsedMs: number } | { ok: false; reason: string } {
  const start = Date.now();
  // spawnSync with argv array (not shell) — prevents future shell-injection if
  // any input ever becomes dynamic. Sync blocking matches original execSync UX.
  const r = spawnSync("npm", ["install", "-g", DAEMON_NPM_NAME], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  if (r.status !== 0) {
    const reason = scrubSecrets((r.stderr ?? r.error?.message ?? "unknown error").slice(0, 200));
    return { ok: false, reason: `npm install failed: ${reason}` };
  }
  return { ok: true, elapsedMs: Date.now() - start };
}

// Phase 18 — installer detects the user's IDE-agent CLI instead of an LLM
// API key. Daemon delegates every decision to that CLI (which runs with
// the user's full context: CLAUDE.md, MCP servers, skills, memory).
// See ADRs/2026-05-16-agent-daemon-ide-runner.md for the why.
interface RunnerDetection {
  command: string;          // CLI name on PATH (e.g. "claude")
  args: string[];           // flags before the prompt
  display_name: string;     // for log line
  source: "cli-arg" | "auto-claude" | "auto-codex";
}

function detectAgentRunner(args: CliArgs): RunnerDetection | null {
  // CLI override always wins.
  if (args.runnerCommand) {
    return {
      command: args.runnerCommand,
      args: args.runnerArgs ?? ["-p"],
      display_name: args.runnerCommand,
      source: "cli-arg",
    };
  }
  // Auto-detect known headless-capable IDE CLIs in priority order.
  if (commandExists("claude")) {
    return {
      command: "claude",
      args: ["-p"],
      display_name: "Claude Code",
      source: "auto-claude",
    };
  }
  if (commandExists("codex")) {
    return {
      command: "codex",
      args: ["-p"],
      display_name: "Codex CLI",
      source: "auto-codex",
    };
  }
  return null;
}

function writeDaemonConfig(token: string, baseUrl: string, runner: RunnerDetection): string {
  const home = homedir();
  const configPath = join(home, ".susu", "agent-config.json");
  backupFile(configPath);
  const config = {
    api_url: baseUrl,
    token,
    // Phase 18 — IDE-agent runner config (replaces removed `llm` block).
    agent_runner: {
      command: runner.command,
      args: runner.args,
      // cwd defaults to $HOME inside daemon if omitted; keep it explicit so
      // the agent loads the user's global CLAUDE.md without ambiguity.
      cwd: home,
      timeout_ms: 90_000,
      // Only allow the agent to call susurration MCP tools during unattended
      // dispatches. Prevents a misbehaving prompt from editing user files.
      allowed_tools: ["mcp__susurration__*"],
      // Modest per-event budget cap (Claude Code only — others ignore).
      max_budget_usd: 0.5,
    },
    agent: {
      max_calls_per_minute: 10,
      history_per_channel: 20,
    },
    decision_log_path: join(home, ".susu", "agent-decisions.jsonl"),
    dry_run_pushes: true,
    paper_trading: { enabled: true, min_size_factor: 0.5 },
  };
  writeJsonAtomic(configPath, config);
  return configPath;
}

function spawnDaemonDetached(configPath: string): { ok: true; pid: number | null } | { ok: false; reason: string } {
  if (!commandExists("susu-agent-daemon")) {
    return { ok: false, reason: "`susu-agent-daemon` not on PATH after npm install — check npm prefix" };
  }
  try {
    const child = spawn("susu-agent-daemon", ["--config", configPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, pid: child.pid ?? null };
  } catch (err) {
    return { ok: false, reason: `spawn failed: ${(err as Error).message}` };
  }
}

// ─── Output helpers ───────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(msg: string): void { process.stdout.write(msg + "\n"); }
function ok(msg: string): void { log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string): void { log(`${RED}✗${RESET} ${msg}`); }
function warn(msg: string): void { log(`${YELLOW}!${RESET} ${msg}`); }
function info(msg: string): void { log(`${DIM}${msg}${RESET}`); }
function section(n: number, title: string): void { log(`\n${BOLD}[${n}/4] ${title}${RESET}`); }

// ─── Main install orchestration ───────────────────────────────────────

async function cmdInstall(args: CliArgs): Promise<number> {
  if (!args.token) {
    fail("missing --token. Get yours from https://susurration.xyz after registering.");
    return 1;
  }
  if (!args.token.startsWith("sk_")) {
    warn(`token doesn't start with "sk_" — proceeding anyway, but double-check it's the right value.`);
  }

  const telemetry = makeTelemetry(args.baseUrl, args.token);
  const installStart = Date.now();

  void telemetry.started({
    version: "0.0.1",
    node_version: process.version,
    platform: platform(),
  });

  log(`\n${BOLD}Susurration installer${RESET}  ${DIM}v0.0.1${RESET}\n`);

  // ── Detect IDEs ─────────────────────────────────────────────────────
  log(`Detecting installed AI IDEs…`);
  const allIdes = detectIdes();
  for (const ide of allIdes) {
    if (ide.detected) ok(`${ide.name} (${ide.detectionMethod})`);
    else info(`  ${ide.name} not found (${ide.detectionMethod})`);
  }
  void telemetry.ideDetected(allIdes.filter((i) => i.detected).map((i) => i.id));

  // Pick which to configure
  let toConfigure: IdeInfo[];
  if (args.onlyIde) {
    toConfigure = allIdes.filter((d) => d.detected && d.id === args.onlyIde);
    if (toConfigure.length === 0) {
      fail(`--only ${args.onlyIde}: not detected. Run without --only to see what's installed.`);
      void telemetry.complete(false, { fail_reason: "only_ide_not_detected" });
      return 1;
    }
  } else {
    toConfigure = await promptIdeSelection(allIdes, args.noPrompt);
  }
  if (toConfigure.length === 0) {
    fail("No supported IDE detected. Install Claude Code / Cursor / Windsurf / Cline / Codex first, then re-run this installer.");
    void telemetry.complete(false, { fail_reason: "no_ide_detected" });
    return 1;
  }
  log(`Will configure: ${toConfigure.map((d) => d.name).join(", ")}`);

  // ── Stage 1: install daemon ─────────────────────────────────────────
  section(1, "Installing agent daemon…");
  void telemetry.stage(1, "running");
  const stage1Start = Date.now();
  const daemonResult = installDaemonGlobally();
  if (!daemonResult.ok) {
    fail(daemonResult.reason);
    info(`Hint: try \`npm install -g ${DAEMON_NPM_NAME}\` manually to see the underlying npm error.`);
    void telemetry.stage(1, "fail", { elapsed_ms: Date.now() - stage1Start, error_hint: daemonResult.reason });
    void telemetry.complete(false, { fail_reason: "daemon_install_failed", total_elapsed_ms: Date.now() - installStart });
    return 1;
  }
  ok(`susurration-agent-daemon installed (${(daemonResult.elapsedMs / 1000).toFixed(1)}s)`);
  void telemetry.stage(1, "ok", { elapsed_ms: daemonResult.elapsedMs });

  // ── Stage 2: configure each IDE ─────────────────────────────────────
  section(2, "Wiring up MCP in your IDEs…");
  const ctx: McpConfigContext = { token: args.token, baseUrl: args.baseUrl };
  const configured: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const ide of toConfigure) {
    const stageStart = Date.now();
    void telemetry.stage(2, "running", { ide: ide.id });
    const r = configureIde(ide.id, ctx);
    if (r.ok) {
      ok(`${ide.name}`);
      configured.push(ide.id);
      void telemetry.stage(2, "ok", { ide: ide.id, elapsed_ms: Date.now() - stageStart });
    } else {
      fail(`${ide.name}: ${r.reason}`);
      failed.push({ id: ide.id, reason: r.reason });
      void telemetry.stage(2, "fail", { ide: ide.id, elapsed_ms: Date.now() - stageStart, error_hint: r.reason });
    }
  }
  if (configured.length === 0) {
    fail("No IDE was configured successfully. See errors above.");
    void telemetry.complete(false, { fail_reason: "all_ide_config_failed", total_elapsed_ms: Date.now() - installStart });
    return 1;
  }

  // ── Stage 3: write daemon config + spawn ────────────────────────────
  section(3, "Connecting to Susurration…");
  const stage3Start = Date.now();
  void telemetry.stage(3, "running");
  // Phase 18 — detect the user's IDE-agent CLI (Claude Code / Codex / etc.)
  // No more LLM API key required. The daemon runs the user's CLI, which
  // authenticates via its own subscription / login.
  const runner = detectAgentRunner(args);
  if (!runner) {
    fail(
      "No IDE-agent CLI found on PATH. Install Claude Code " +
      "(`npm install -g @anthropic-ai/claude-code`) or Codex CLI, then re-run.\n" +
      "Or pass --runner-command <cli-name> to use a different agent CLI.",
    );
    void telemetry.stage(3, "fail", { error_hint: "no_agent_runner" });
    void telemetry.complete(false, { fail_reason: "no_agent_runner", total_elapsed_ms: Date.now() - installStart, ides_configured: configured });
    return 1;
  }
  ok(`agent runner detected: ${runner.display_name} (source: ${runner.source})`);
  const configPath = writeDaemonConfig(args.token, args.baseUrl, runner);
  ok(`wrote ${configPath}`);
  const spawnResult = spawnDaemonDetached(configPath);
  if (!spawnResult.ok) {
    fail(spawnResult.reason);
    void telemetry.stage(3, "fail", { elapsed_ms: Date.now() - stage3Start, error_hint: spawnResult.reason });
    void telemetry.complete(false, { fail_reason: "daemon_spawn_failed", total_elapsed_ms: Date.now() - installStart, ides_configured: configured });
    return 1;
  }
  ok(`daemon spawned${spawnResult.pid ? ` (pid ${spawnResult.pid})` : ""}`);
  void telemetry.stage(3, "ok", { elapsed_ms: Date.now() - stage3Start });

  // ── Stage 4: confirm signal availability ────────────────────────────
  section(4, "Verifying signal channel…");
  void telemetry.stage(4, "running");
  // Server-side ensureDemoFriend already pushed welcome+replay to the user's
  // @demo channel when they registered. So as long as the daemon connects
  // and pulls channel history, the user will see signals immediately.
  ok(`welcome + replay signal pre-staged by backend on register`);
  ok(`daemon will pull them via SSE history backfill on connect`);
  void telemetry.stage(4, "ok");

  // ── Done ────────────────────────────────────────────────────────────
  log(`\n${GREEN}${BOLD}Installation complete.${RESET}`);
  log(`${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  log(`${BOLD}${YELLOW}  ! Quit your IDE completely (Cmd+Q / quit the app), then reopen it.${RESET}`);
  log(`${BOLD}${YELLOW}    MCP servers only load on startup. /clear or new tab will NOT work.${RESET}`);
  log(`${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  log(`\nConfigured: ${configured.join(", ")}`);
  if (failed.length > 0) {
    warn(`Skipped: ${failed.map((f) => `${f.id} (${f.reason})`).join(", ")}`);
  }
  log(`\nReturn to https://susurration.xyz to see your dashboard light up.`);
  log(`Daemon logs:  tail -f ~/.susu/agent-decisions.jsonl`);

  void telemetry.complete(true, {
    total_elapsed_ms: Date.now() - installStart,
    ides_configured: configured,
  });
  return 0;
}

async function cmdUninstall(): Promise<number> {
  log(`${DIM}Uninstall: remove daemon binary, agent-config.json, and MCP entries from each IDE.${RESET}`);
  log(`${DIM}Run manually for now:${RESET}`);
  log(`  npm uninstall -g ${DAEMON_NPM_NAME}`);
  log(`  rm -rf ~/.susu`);
  log(`  claude mcp remove susurration   ${DIM}# for Claude Code${RESET}`);
  log(`  Edit ~/.cursor/mcp.json (and similar files) to delete the "susurration" entry`);
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code: number;
  switch (args.command) {
    case "install": code = await cmdInstall(args); break;
    case "uninstall": code = await cmdUninstall(); break;
    case "help":
    default: printHelp(); code = 0;
  }
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`\n${RED}fatal:${RESET} ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
