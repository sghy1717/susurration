#!/usr/bin/env node

// src/index.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
var DEFAULT_BASE_URL = "https://susurration.xyz/api";
var DAEMON_NPM_NAME = "susurration-agent-daemon";
var MCP_NPM_NAME = "@susurration/mcp";
function parseArgs(argv) {
  const args = {
    command: "help",
    token: "",
    baseUrl: DEFAULT_BASE_URL,
    noPrompt: false
  };
  if (argv.length === 0)
    return args;
  args.command = argv[0] ?? "help";
  for (let i = 1;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token")
      args.token = argv[++i] ?? "";
    else if (a === "--base-url") {
      const url = argv[++i] ?? DEFAULT_BASE_URL;
      if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        process.stderr.write(`\x1B[31mfatal:\x1B[0m --base-url must use https:// (got: ${url})
`);
        process.exit(2);
      }
      args.baseUrl = url;
    } else if (a === "--runner-command")
      args.runnerCommand = argv[++i];
    else if (a === "--runner-args")
      args.runnerArgs = (argv[++i] ?? "").split(/\s+/).filter(Boolean);
    else if (a === "--no-prompt")
      args.noPrompt = true;
    else if (a === "--only")
      args.onlyIde = argv[++i];
    else if (a === "--help" || a === "-h")
      args.command = "help";
  }
  return args;
}
function printHelp() {
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
function makeTelemetry(baseUrl, token) {
  const post = async (path, body) => {
    try {
      const ctrl = new AbortController;
      const t = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(t);
    } catch {}
  };
  return {
    started: (payload) => post("/installer/started", payload),
    ideDetected: (ides) => post("/installer/ide-detected", { ides }),
    stage: (stage, status, extra) => post("/installer/stage", { stage, status, ...extra }),
    complete: (success, extra) => post("/installer/complete", { success, ...extra })
  };
}
function commandExists(cmd) {
  try {
    const r = spawnSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}
function dirExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
function detectIdes() {
  const home = homedir();
  return [
    {
      id: "claude",
      name: "Claude Code",
      detected: commandExists("claude"),
      detectionMethod: "`claude` CLI on PATH"
    },
    {
      id: "cursor",
      name: "Cursor",
      detected: dirExists(join(home, ".cursor")) || commandExists("cursor"),
      detectionMethod: "~/.cursor or `cursor` CLI"
    },
    {
      id: "windsurf",
      name: "Windsurf",
      detected: dirExists(join(home, ".codeium", "windsurf")) || commandExists("windsurf"),
      detectionMethod: "~/.codeium/windsurf"
    },
    {
      id: "cline",
      name: "Cline",
      detected: dirExists(join(home, "Documents", "Cline")) || dirExists(join(home, ".cline")),
      detectionMethod: "~/Documents/Cline or ~/.cline"
    },
    {
      id: "codex",
      name: "Codex CLI",
      detected: dirExists(join(home, ".codex")) || commandExists("codex"),
      detectionMethod: "~/.codex or `codex` CLI"
    }
  ];
}
async function promptIdeSelection(detected, noPrompt) {
  const installable = detected.filter((d) => d.detected);
  if (installable.length === 0) {
    return [];
  }
  if (noPrompt || !process.stdin.isTTY) {
    return installable;
  }
  process.stdout.write(`
Detected IDEs (press Enter to install to ALL, or type comma-separated names to limit):
`);
  installable.forEach((d, i) => {
    process.stdout.write(`  [${i + 1}] ${d.name} (${d.id})
`);
  });
  process.stdout.write(`
Your choice [all]: `);
  const line = await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  if (line === "" || line.toLowerCase() === "all")
    return installable;
  const picked = new Set(line.split(",").map((s) => s.trim().toLowerCase()));
  return installable.filter((d) => picked.has(d.id) || picked.has(d.name.toLowerCase()));
}
function backupFile(path) {
  if (!existsSync(path))
    return;
  const ts = Date.now();
  copyFileSync(path, `${path}.bak.${ts}`);
}
function readJsonSafe(path) {
  try {
    if (!existsSync(path))
      return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + `
`, { mode: 384 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
function scrubSecrets(s) {
  return s.replace(/sk_[A-Za-z0-9_-]+/g, "sk_***").replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***").replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-***").replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}
function mcpServerEntry(ctx) {
  return {
    command: "npx",
    args: ["-y", MCP_NPM_NAME],
    env: { SUSU_TOKEN: ctx.token, ...ctx.baseUrl !== DEFAULT_BASE_URL ? { SUSU_BASE_URL: ctx.baseUrl } : {} }
  };
}
function configureClaudeCode(ctx) {
  if (!commandExists("claude")) {
    return { ok: false, reason: "`claude` CLI not on PATH — install Claude Code first" };
  }
  try {
    spawnSync("claude", ["mcp", "remove", "susurration", "--scope", "user"], { stdio: "ignore" });
  } catch {}
  try {
    spawnSync("claude", ["mcp", "remove", "susurration", "--scope", "local"], { stdio: "ignore" });
  } catch {}
  const args = [
    "mcp",
    "add",
    "susurration",
    "--scope",
    "user",
    "-e",
    `SUSU_TOKEN=${ctx.token}`,
    ...ctx.baseUrl !== DEFAULT_BASE_URL ? ["-e", `SUSU_BASE_URL=${ctx.baseUrl}`] : [],
    "--",
    "npx",
    "-y",
    MCP_NPM_NAME
  ];
  const r = spawnSync("claude", args, { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, reason: `claude mcp add failed: ${scrubSecrets((r.stderr ?? "").slice(0, 200))}` };
  }
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const settings = readJsonSafe(settingsPath) ?? {};
    const permissions = settings.permissions ?? {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    const toAdd = [
      "mcp__susurration",
      "mcp__susurration__susu_signal_accept",
      "mcp__susurration__susu_signal_reject",
      "mcp__susurration__susu_signal_push",
      "mcp__susurration__susu_position_close",
      "mcp__susurration__susu_signals_recent",
      "mcp__susurration__susu_signals_feed"
    ];
    let mutated = false;
    for (const entry of toAdd) {
      if (!allow.includes(entry)) {
        allow.push(entry);
        mutated = true;
      }
    }
    if (mutated) {
      permissions.allow = allow;
      settings.permissions = permissions;
      backupFile(settingsPath);
      writeJsonAtomic(settingsPath, settings);
    }
  } catch (err) {
    return {
      ok: true
    };
  }
  return { ok: true };
}
function configureJsonBasedIde(configPath, topKey, ctx) {
  try {
    backupFile(configPath);
    const existing = readJsonSafe(configPath) ?? {};
    const servers = existing[topKey] ?? {};
    servers["susurration"] = mcpServerEntry(ctx);
    existing[topKey] = servers;
    writeJsonAtomic(configPath, existing);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `failed to write ${configPath}: ${err.message}` };
  }
}
function configureIde(id, ctx) {
  const home = homedir();
  switch (id) {
    case "claude":
      return configureClaudeCode(ctx);
    case "cursor":
      return configureJsonBasedIde(join(home, ".cursor", "mcp.json"), "mcpServers", ctx);
    case "windsurf":
      return configureJsonBasedIde(join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", ctx);
    case "cline":
      return configureJsonBasedIde(platform() === "darwin" ? join(home, "Documents", "Cline", "MCP", "cline_mcp_settings.json") : join(home, ".cline", "mcp_settings.json"), "mcpServers", ctx);
    case "codex":
      return configureJsonBasedIde(join(home, ".codex", "mcp_settings.json"), "mcp", ctx);
  }
}
function installDaemonGlobally() {
  const start = Date.now();
  const r = spawnSync("npm", ["install", "-g", DAEMON_NPM_NAME], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 5 * 60 * 1000
  });
  if (r.status !== 0) {
    const reason = scrubSecrets((r.stderr ?? r.error?.message ?? "unknown error").slice(0, 200));
    return { ok: false, reason: `npm install failed: ${reason}` };
  }
  return { ok: true, elapsedMs: Date.now() - start };
}
function detectAgentRunner(args) {
  if (args.runnerCommand) {
    return {
      command: args.runnerCommand,
      args: args.runnerArgs ?? ["-p"],
      display_name: args.runnerCommand,
      source: "cli-arg"
    };
  }
  if (commandExists("claude")) {
    return {
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      display_name: "Claude Code",
      source: "auto-claude"
    };
  }
  if (commandExists("codex")) {
    return null;
  }
  return null;
}
function writeDaemonConfig(token, baseUrl, runner) {
  const home = homedir();
  const configPath = join(home, ".susu", "agent-config.json");
  backupFile(configPath);
  const config = {
    api_url: baseUrl,
    token,
    agent_runner: {
      command: runner.command,
      args: runner.args,
      cwd: home,
      timeout_ms: 90000
    },
    agent: {
      max_calls_per_minute: 10,
      history_per_channel: 20
    },
    decision_log_path: join(home, ".susu", "agent-decisions.jsonl"),
    state_path: join(home, ".susu", "agent-daemon.state.json"),
    dry_run_pushes: true,
    paper_trading: { enabled: true, min_size_factor: 0.5 }
  };
  writeJsonAtomic(configPath, config);
  return configPath;
}
function spawnDaemonDetached(configPath) {
  if (!commandExists("susu-agent-daemon")) {
    return { ok: false, reason: "`susu-agent-daemon` not on PATH after npm install — check npm prefix" };
  }
  try {
    const child = spawn("susu-agent-daemon", ["--config", configPath], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { ok: true, pid: child.pid ?? null };
  } catch (err) {
    return { ok: false, reason: `spawn failed: ${err.message}` };
  }
}
var GREEN = "\x1B[32m";
var RED = "\x1B[31m";
var YELLOW = "\x1B[33m";
var DIM = "\x1B[2m";
var BOLD = "\x1B[1m";
var RESET = "\x1B[0m";
function log(msg) {
  process.stdout.write(msg + `
`);
}
function ok(msg) {
  log(`${GREEN}✓${RESET} ${msg}`);
}
function fail(msg) {
  log(`${RED}✗${RESET} ${msg}`);
}
function warn(msg) {
  log(`${YELLOW}!${RESET} ${msg}`);
}
function info(msg) {
  log(`${DIM}${msg}${RESET}`);
}
function section(n, title) {
  log(`
${BOLD}[${n}/4] ${title}${RESET}`);
}
async function cmdInstall(args) {
  if (!args.token) {
    fail("missing --token. Get yours from https://susurration.xyz after registering.");
    return 1;
  }
  if (!args.token.startsWith("sk_")) {
    warn(`token doesn't start with "sk_" — proceeding anyway, but double-check it's the right value.`);
  }
  const telemetry = makeTelemetry(args.baseUrl, args.token);
  const installStart = Date.now();
  telemetry.started({
    version: "0.0.1",
    node_version: process.version,
    platform: platform()
  });
  log(`
${BOLD}Susurration installer${RESET}  ${DIM}v0.0.1${RESET}
`);
  log(`Detecting installed AI IDEs…`);
  const allIdes = detectIdes();
  for (const ide of allIdes) {
    if (ide.detected)
      ok(`${ide.name} (${ide.detectionMethod})`);
    else
      info(`  ${ide.name} not found (${ide.detectionMethod})`);
  }
  telemetry.ideDetected(allIdes.filter((i) => i.detected).map((i) => i.id));
  let toConfigure;
  if (args.onlyIde) {
    toConfigure = allIdes.filter((d) => d.detected && d.id === args.onlyIde);
    if (toConfigure.length === 0) {
      fail(`--only ${args.onlyIde}: not detected. Run without --only to see what's installed.`);
      telemetry.complete(false, { fail_reason: "only_ide_not_detected" });
      return 1;
    }
  } else {
    toConfigure = await promptIdeSelection(allIdes, args.noPrompt);
  }
  if (toConfigure.length === 0) {
    fail("No supported IDE detected. Install Claude Code / Cursor / Windsurf / Cline / Codex first, then re-run this installer.");
    telemetry.complete(false, { fail_reason: "no_ide_detected" });
    return 1;
  }
  log(`Will configure: ${toConfigure.map((d) => d.name).join(", ")}`);
  section(1, "Installing agent daemon…");
  telemetry.stage(1, "running");
  const stage1Start = Date.now();
  const daemonResult = installDaemonGlobally();
  if (!daemonResult.ok) {
    fail(daemonResult.reason);
    info(`Hint: try \`npm install -g ${DAEMON_NPM_NAME}\` manually to see the underlying npm error.`);
    telemetry.stage(1, "fail", { elapsed_ms: Date.now() - stage1Start, error_hint: daemonResult.reason });
    telemetry.complete(false, { fail_reason: "daemon_install_failed", total_elapsed_ms: Date.now() - installStart });
    return 1;
  }
  ok(`susurration-agent-daemon installed (${(daemonResult.elapsedMs / 1000).toFixed(1)}s)`);
  telemetry.stage(1, "ok", { elapsed_ms: daemonResult.elapsedMs });
  section(2, "Wiring up MCP in your IDEs…");
  const ctx = { token: args.token, baseUrl: args.baseUrl };
  const configured = [];
  const failed = [];
  for (const ide of toConfigure) {
    const stageStart = Date.now();
    telemetry.stage(2, "running", { ide: ide.id });
    const r = configureIde(ide.id, ctx);
    if (r.ok) {
      ok(`${ide.name}`);
      configured.push(ide.id);
      telemetry.stage(2, "ok", { ide: ide.id, elapsed_ms: Date.now() - stageStart });
    } else {
      fail(`${ide.name}: ${r.reason}`);
      failed.push({ id: ide.id, reason: r.reason });
      telemetry.stage(2, "fail", { ide: ide.id, elapsed_ms: Date.now() - stageStart, error_hint: r.reason });
    }
  }
  if (configured.length === 0) {
    fail("No IDE was configured successfully. See errors above.");
    telemetry.complete(false, { fail_reason: "all_ide_config_failed", total_elapsed_ms: Date.now() - installStart });
    return 1;
  }
  section(3, "Connecting to Susurration…");
  const stage3Start = Date.now();
  telemetry.stage(3, "running");
  const runner = detectAgentRunner(args);
  if (!runner) {
    fail("No IDE-agent CLI found on PATH. Install Claude Code " + "(`npm install -g @anthropic-ai/claude-code`) or Codex CLI, then re-run.\n" + "Or pass --runner-command <cli-name> to use a different agent CLI.");
    telemetry.stage(3, "fail", { error_hint: "no_agent_runner" });
    telemetry.complete(false, { fail_reason: "no_agent_runner", total_elapsed_ms: Date.now() - installStart, ides_configured: configured });
    return 1;
  }
  ok(`agent runner detected: ${runner.display_name} (source: ${runner.source})`);
  const configPath = writeDaemonConfig(args.token, args.baseUrl, runner);
  ok(`wrote ${configPath}`);
  const spawnResult = spawnDaemonDetached(configPath);
  if (!spawnResult.ok) {
    fail(spawnResult.reason);
    telemetry.stage(3, "fail", { elapsed_ms: Date.now() - stage3Start, error_hint: spawnResult.reason });
    telemetry.complete(false, { fail_reason: "daemon_spawn_failed", total_elapsed_ms: Date.now() - installStart, ides_configured: configured });
    return 1;
  }
  ok(`daemon spawned${spawnResult.pid ? ` (pid ${spawnResult.pid})` : ""}`);
  telemetry.stage(3, "ok", { elapsed_ms: Date.now() - stage3Start });
  section(4, "Verifying signal channel…");
  telemetry.stage(4, "running");
  ok(`welcome + replay signal pre-staged by backend on register`);
  ok(`daemon will pull them via SSE history backfill on connect`);
  telemetry.stage(4, "ok");
  log(`
${GREEN}${BOLD}Installation complete.${RESET}`);
  log(`${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  log(`${BOLD}${YELLOW}  ! Quit your IDE completely (Cmd+Q / quit the app), then reopen it.${RESET}`);
  log(`${BOLD}${YELLOW}    MCP servers only load on startup. /clear or new tab will NOT work.${RESET}`);
  log(`${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  log(`
Configured: ${configured.join(", ")}`);
  if (failed.length > 0) {
    warn(`Skipped: ${failed.map((f) => `${f.id} (${f.reason})`).join(", ")}`);
  }
  log(`
Return to https://susurration.xyz to see your dashboard light up.`);
  log(`Daemon logs:  tail -f ~/.susu/agent-decisions.jsonl`);
  log(``);
  log(`${BOLD}Cost:${RESET}`);
  log(`  Each incoming signal triggers a \`${runner.command} ${runner.args.join(" ")}\` invocation`);
  log(`  that uses your ${runner.display_name} subscription / API key.`);
  log(`  Susurration does not cap this. To control cost:`);
  log(`    - configure your IDE-side budget (model + token settings)`);
  log(`    - or set \`max_calls_per_minute\` in ${configPath}`);
  telemetry.complete(true, {
    total_elapsed_ms: Date.now() - installStart,
    ides_configured: configured
  });
  return 0;
}
async function cmdUninstall() {
  log(`${DIM}Uninstall: remove daemon binary, agent-config.json, and MCP entries from each IDE.${RESET}`);
  log(`${DIM}Run manually for now:${RESET}`);
  log(`  npm uninstall -g ${DAEMON_NPM_NAME}`);
  log(`  rm -rf ~/.susu`);
  log(`  claude mcp remove susurration   ${DIM}# for Claude Code${RESET}`);
  log(`  Edit ~/.cursor/mcp.json (and similar files) to delete the "susurration" entry`);
  return 0;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  let code;
  switch (args.command) {
    case "install":
      code = await cmdInstall(args);
      break;
    case "uninstall":
      code = await cmdUninstall();
      break;
    case "help":
    default:
      printHelp();
      code = 0;
  }
  process.exit(code);
}
main().catch((err) => {
  process.stderr.write(`
${RED}fatal:${RESET} ${err.stack ?? err}
`);
  process.exit(2);
});
