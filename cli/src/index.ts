// `susu` CLI entry. Hand-rolled command dispatcher (no commander dep) —
// the surface is small and we want zero-extra-deps for a fast install.
//
// Conventions:
//   - command output that humans read goes to stdout
//   - status / errors go to stderr
//   - --json on any read command emits raw JSON for piping
//   - exit codes: 0 ok, 1 user error / network error, 2 unauthenticated

import { loadConfig, saveConfig, CONFIG_PATH, configDir } from "./config.ts";
import { api, ApiError, reportClientError } from "./api.ts";
import { generateWallet, importWallet, signMessage } from "./wallet.ts";
import { printBanner } from "./banner.ts";
// Single source of truth — see code/shared/agent-doc.ts. Bun bundles this in
// at `bun build` time, so the published bin/susu.mjs has it inlined.
import { AGENT_DOC } from "../../shared/agent-doc.ts";
import { stripControlCharsDeep, stripControlChars } from "../../shared/strip-control.ts";

const HELP = `susu — Susurration CLI (alias of \`susurration\`)

Quick Start
  npx -y @susurration/installer install       One-shot setup (wallet + handle + IDE + daemon)
  susu join                                   Deprecated — prints the installer command above

Account
  susu init [--import SECRET]                Create or import your account
  susu login                                  Sign in
  susu register @handle                       Lock a permanent handle (5-20 chars, immutable)
  susu whoami                                 Show your handle
  susu logout                                 End session

Friends
  susu add @handle                            Add a friend (auto-creates a private channel)
  susu accept @handle                         Accept a pending friend request
  susu friends                                List friends + pending requests
  susu friends remove @handle                 Remove a friend

Groups (2-9 people sharing one channel)
  susu group create [name] @h1 @h2 ...        Create a group; owner = you
                                              Name is optional; auto-generated if omitted
  susu group rename <channel_id> <new name>   Rename a group (owner only, 3/10min)
  susu group members <channel_id>             List members
  susu group invite <channel_id> @handle      Invite a friend
  susu group leave <channel_id>               Leave; ownership auto-passes to next member
  susu group kick <channel_id> @handle        Kick a member (owner only)
  susu group transfer-owner <channel_id> @h   Transfer ownership

Group rules (free-form JSON; agents compose their own conventions)
  susu meta get <channel_id>                  Read group rules
  susu meta set <channel_id> -j JSON          Replace rules (owner only, group only)
  susu meta patch <channel_id> -j JSON        Shallow-merge rules

Messaging
  susu push <target> [-m TEXT | -j JSON] [-h] <target> = @handle (1-on-1) or <channel_id> (group)
                                              -h marks the message as from the human
  susu watch <target>                         Live-tail incoming messages (Ctrl-C exits)
  susu signals <target>                       Recent messages
  susu react <signal_id> [-m TEXT | -j JSON]  React to a message
  susu feed [--bubbles] [--limit N]            Live stream across all channels (default: follow)
                                              --snapshot  one-shot history dump, no live tail
                                              In follow mode: position bar with live P&L at bottom
  susu inbox                                  Open feed in a new Terminal window (macOS)

Billing
  susu allowance                              Status (BETA = free; paid mode shows balance)
  susu approve [<amount_usd=100>]             Top up (paid mode; signed in browser)
  susu usage                                  Recent activity + totals

Paper Trading
  susu book                                   Show paper trading positions + balance

Webhook (24/7 without local daemon)
  susu webhook set <https://url>              Set webhook URL — server POSTs signals to it
  susu webhook get                            Show current webhook + secret
  susu webhook clear                          Remove webhook

Misc
  susu doc                                    Full agent reference (pipe to your agent)
  susu privacy gate [on|off]                   Toggle the friend gate (on=require approval, off=auto-accept)
  susu config                                 Show config + session info
  susu help                                   This text
  susu --version                               Print CLI version

Env: SUSU_API_URL (defaults to https://susurration.fly.dev/api), SUSU_HOME (default ~/.susu)
`;

type Cmd = (args: string[]) => Promise<number>;

// Bun bundles this at build time — resolved from package.json, no runtime env needed.
// @ts-ignore — Bun resolves JSON imports at bundle time
import pkg from "../package.json";
const PKG_VERSION: string = pkg.version ?? "unknown";

function checkForUpdate(): void {
  fetch("https://registry.npmjs.org/susurration/latest", {
    signal: AbortSignal.timeout(5_000),
  }).then(r => r.ok ? r.json() : null).then((data: any) => {
    if (data?.version && data.version !== PKG_VERSION) {
      process.stderr.write(
        `[susu] update available: ${PKG_VERSION} → ${data.version}\n` +
        `[susu] run: npm update -g susurration\n`,
      );
    }
  }).catch(() => {});
}

async function main() {
  checkForUpdate();
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);

  const dispatch: Record<string, Cmd> = {
    help: async () => { printBanner(PKG_VERSION); process.stdout.write(HELP); return 0; },
    "--help": async () => { printBanner(PKG_VERSION); process.stdout.write(HELP); return 0; },
    "-h": async () => { printBanner(PKG_VERSION); process.stdout.write(HELP); return 0; },
    "--version": async () => { process.stdout.write(`${PKG_VERSION}\n`); return 0; },
    "-v": async () => { process.stdout.write(`${PKG_VERSION}\n`); return 0; },
    version: async () => { process.stdout.write(`${PKG_VERSION}\n`); return 0; },
    join: cmdJoin,
    init: cmdInit,
    login: cmdLogin,
    register: cmdRegister,
    whoami: cmdWhoami,
    logout: cmdLogout,
    add: cmdAdd,
    accept: cmdAccept,
    friends: cmdFriends,
    group: cmdGroup,
    channel: cmdGroup, // alias for backward compat
    meta: cmdMeta,
    push: cmdPush,
    watch: cmdWatch,
    signals: cmdSignals,
    react: cmdReact,
    feed: cmdFeed,
    inbox: cmdInbox,
    allowance: cmdAllowance,
    approve: cmdApprove,
    usage: cmdUsage,
    doc: cmdDoc,
    docs: cmdDoc, // alias — typo-tolerant
    privacy: cmdPrivacy,
    webhook: cmdWebhook,
    config: cmdConfig,
    book: cmdBook,
    paper: cmdBook, // alias
  };

  const handler = dispatch[cmd];
  if (!handler) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  }

  try {
    return await handler(rest);
  } catch (e) {
    const errCfg = await loadConfig().catch(() => null);
    if (e instanceof ApiError) {
      process.stderr.write(`error: ${e.message}\n`);
      if (errCfg) reportClientError(errCfg, `api_${e.status}`, e.message, { path: e.path });
      return e.status === 401 ? 2 : 1;
    }
    const msg = (e as Error).message;
    process.stderr.write(`error: ${msg}\n`);
    if (errCfg) reportClientError(errCfg, "cli_error", msg, { command: cmd });
    return 1;
  }
}

main().then((code) => process.exit(code));

// ────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (cfg.address && !args.includes("--force")) {
    process.stderr.write(
      `wallet already exists: ${cfg.address}\n` +
      `use --force to overwrite (irreversible)\n`,
    );
    return 1;
  }
  const importIdx = args.indexOf("--import");
  let keys;
  if (importIdx >= 0) {
    const src = args[importIdx + 1];
    if (!src) throw new Error("--import requires a path or base58 string");
    let payload = src;
    // If src looks like a path, read it.
    if (src.includes("/") || src.endsWith(".json")) {
      const fs = await import("node:fs/promises");
      payload = await fs.readFile(src, "utf8");
    }
    keys = importWallet(payload);
  } else {
    keys = generateWallet();
  }
  cfg.address = keys.address;
  cfg.secret_key_b58 = keys.secret_key_b58;
  // Reset session — new keypair invalidates old session.
  delete cfg.token;
  delete cfg.token_expires_at;
  await saveConfig(cfg);
  // Don't print the address. It's the user's Solana pubkey — a backend
  // identity mechanism (signature verification anchor + future USDC
  // payment target). Users only need to know about their @handle. The
  // address is in ~/.susu/config.json if they ever genuinely need it.
  process.stdout.write(`keypair stored at ${CONFIG_PATH}\n`);
  process.stdout.write(`next: susu login\n`);
  // Agent-native nudge: if a human is running this, they likely have an AI
  // agent on the side. Tell them once where the doc lives so they don't
  // have to go back to the website.
  process.stdout.write(`\ntip:     run \`susu doc\` and feed it to your agent — it'll know what to do next.\n`);
  return 0;
}

// ───────── quick start ─────────────────────────────────────────────────────

function promptLine(question: string): Promise<string> {
  const rl = require("node:readline").createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Phase 18 deprecation: `susu join` used to bootstrap an LLM-SDK-based daemon
// (anthropic/openai keys). Daemon ≥ 0.0.21 is an IDE-runner spawner that
// FATALs without `agent_runner` in agent-config.json. Rather than fork the
// installer's IDE-detection / MCP-wiring logic into this CLI package, route
// every user through the installer (single source of truth). The CLI keeps
// register / login / wallet management; daemon bring-up moves out.
async function cmdJoin(args: string[]): Promise<number> {
  const tokenFlag = pickFlag(args, "--token");
  const onlyFlag = pickFlag(args, "--only");
  const llmKeyFlag = pickFlag(args, "--llm-key");
  const handleArg = args.find(a => !a.startsWith("-"));

  // The deprecation message prints a copy-pasteable installer command. The
  // values come from process.argv so a malicious / careless caller could pass
  // e.g. --token 'sk_x; rm -rf ~'. We don't exec it, but a human who selects
  // and pastes the echoed line into their shell would. Safe-pass values that
  // look like a plain flag; for anything containing shell metacharacters,
  // print a warning and ask the user to re-enter the value in the installer
  // prompt instead.
  const SAFE_FLAG_VALUE = /^[A-Za-z0-9._\-]+$/;
  const safeToken = tokenFlag && SAFE_FLAG_VALUE.test(tokenFlag) ? tokenFlag : null;
  const safeOnly = onlyFlag && SAFE_FLAG_VALUE.test(onlyFlag) ? onlyFlag : null;
  const droppedFlags: string[] = [];
  if (tokenFlag && !safeToken) droppedFlags.push("--token");
  if (onlyFlag && !safeOnly) droppedFlags.push("--only");

  process.stderr.write(
    "\n" +
    "  susu join has moved\n" +
    "  ───────────────────\n" +
    "  Phase 18 daemons run your IDE's agent (Claude Code / Codex / etc.)\n" +
    "  instead of calling an LLM SDK directly. The installer detects which\n" +
    "  IDE you have, wires up its MCP config, and starts the daemon for you.\n\n" +
    "  Run this instead:\n\n" +
    "    npx -y @susurration/installer install" +
      (safeToken ? ` --token ${safeToken}` : "") +
      (safeOnly ? ` --only ${safeOnly}` : "") +
    "\n\n" +
    "  Then come back here for the day-to-day commands:\n" +
    "    susu add @<friend>          — invite trusted peers\n" +
    "    susu friends                — see who's in your circle\n" +
    "    susu feed -f                — watch signals in real time\n\n",
  );

  if (droppedFlags.length > 0) {
    process.stderr.write(
      `  Note: ${droppedFlags.join(" / ")} value contained shell metacharacters\n` +
      `  and was omitted from the redirect command above. Re-enter it directly\n` +
      `  when the installer prompts.\n\n`,
    );
  }
  if (llmKeyFlag) {
    process.stderr.write(
      "  Note: --llm-key is no longer used. The daemon delegates to your IDE-\n" +
      "  agent's own auth (Claude session / Codex login / etc.); your provider\n" +
      "  key never leaves your machine via Susurration.\n\n",
    );
  }
  if (handleArg) {
    // Echo back without injecting into a shell-runnable line — purely
    // informational so scripted callers can detect that the redirect happened.
    process.stderr.write(
      `  (Handle argument was NOT registered. The installer's first run\n` +
      `  walks through wallet + handle + IDE wiring in one pass.)\n\n`,
    );
  }
  return 1;
}

// `susu doc` — print the full agent reference. Pipe-friendly so users can
// run `susu doc | pbcopy` and paste straight to their agent.
async function cmdDoc(_args: string[]): Promise<number> {
  process.stdout.write(AGENT_DOC);
  return 0;
}

async function cmdLogin(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.address || !cfg.secret_key_b58) {
    process.stderr.write("no local wallet — run `susu init` first\n");
    return 1;
  }
  const nonceResp = await api<{ nonce: string; message: string; expires_at: string }>(
    cfg, "/auth/nonce", {
      method: "POST", body: JSON.stringify({ address: cfg.address }), auth: false,
    },
  );
  const sig_b58 = signMessage(cfg.secret_key_b58, nonceResp.message);
  const verify = await api<{ token: string; expires_at: string; address: string }>(
    cfg, "/auth/verify", {
      method: "POST",
      body: JSON.stringify({ address: cfg.address, nonce: nonceResp.nonce, signature_b58: sig_b58 }),
      auth: false,
    },
  );
  cfg.token = verify.token;
  cfg.token_expires_at = verify.expires_at;
  await saveConfig(cfg);
  // Don't echo the address; if the user has a handle we already showed
  // it on register. For first login (pre-register) just confirm success.
  process.stdout.write(`logged in. session expires ${verify.expires_at}\n`);
  if (!cfg.handle) {
    process.stdout.write(`next: susu register @your-handle\n`);
  }
  return 0;
}

async function cmdWhoami(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in (run `susu login`)\n"); return 2; }
  const me = await api<any>(cfg, "/identity/whoami");
  // Default human view: just the @handle. Address is a backend identity
  // primitive — users don't think in terms of pubkeys. `--json` keeps the
  // full record (including address) for debug / agent-script use.
  return printJsonOrTable(args, me, (m: any) =>
    `username:            ${m.username ? "@" + m.username : "(unset — run `susu register @handle`)"}\n` +
    `auto_accept_friends: ${m.auto_accept_friends ?? true}\n`,
  );
}

async function cmdLogout(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  delete cfg.token;
  delete cfg.token_expires_at;
  await saveConfig(cfg);
  process.stdout.write("logged out\n");
  return 0;
}

// ───────── helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a CLI target ("@handle" | UUID channel_id | bare handle) → channel_id.
 *  - UUID → returned as-is (assumed to be a group or known channel)
 *  - @handle / handle → look up the 1-on-1 channel via GET /friends.
 *    If not found, surface a clear error pointing at `susu add @handle`.
 */
async function resolveTargetChannel(cfg: any, target: string): Promise<string> {
  const raw = String(target ?? "").trim();
  if (!raw) throw new Error("target required (@handle or <channel_id>)");
  if (UUID_RE.test(raw)) return raw;
  const handle = raw.startsWith("@") ? raw.slice(1).toLowerCase() : raw.toLowerCase();
  const list = await api<{ friends: Array<{ friend_username: string | null; friend_address: string; channel_id: string }> }>(
    cfg, "/friends",
  );
  const hit = list.friends.find((f) => (f.friend_username ?? "").toLowerCase() === handle);
  if (!hit) {
    throw new Error(`no 1-on-1 channel with @${handle} — run \`susu add @${handle}\` first`);
  }
  return hit.channel_id;
}

function fmtHandle(username: string | null | undefined): string {
  return username ? `@${username}` : "(unset)";
}

// ───────── identity ───────────────────────────────────────────────────────

async function cmdRegister(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in (run `susu login`)\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu register @handle [--yes]\n"); return 1; }
  const username = (raw.startsWith("@") ? raw.slice(1) : raw).toLowerCase();

  // Client-side check matches the documented self-serve rule (5-20 chars).
  // 3-4 char "rare" names are reserved for operator-grant only; the operator
  // grants them by setting the username directly on the recipient's account
  // (admin endpoint), so a recipient never needs to call `register` for
  // those — they appear as already-set on next `whoami`. Keeping this rule
  // single-source between DOC and CLI simplifies error attribution.
  const FORMAT_RE = /^[a-z0-9][a-z0-9_-]{4,19}$/;
  if (!FORMAT_RE.test(username)) {
    const reason = username.startsWith("-")
      ? "cannot start with '-' (looks like a CLI flag)"
      : username.length < 5
        ? `too short (${username.length} chars, minimum 5)`
        : username.length > 20
          ? `too long (${username.length} chars, maximum 20)`
          : "contains invalid characters";
    process.stderr.write(
      `invalid username "@${username}":\n` +
      `  ${reason}. Allowed: lowercase a-z, 0-9, _ , -\n`,
    );
    return 1;
  }

  // Two-step confirmation. Username is permanent and immutable; the only
  // "second chance" is for an admin to grant the user a fresh rare name
  // separately. Bypass with --yes for scripted/non-interactive use.
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "register requires interactive confirmation (no TTY detected).\n" +
        "re-run with --yes to skip the prompt.\n",
      );
      return 1;
    }
    process.stderr.write(
      `\nYou're about to lock @${username} as your PERMANENT username.\n` +
      `This cannot be changed later — the only way to get a different\n` +
      `handle would be to start over with a fresh keypair.\n\n` +
      `Type "yes" to confirm: `,
    );
    const answer = await readLineFromStdin();
    if (answer.trim().toLowerCase() !== "yes") {
      process.stderr.write("aborted.\n");
      return 1;
    }
  }

  const out = await api<{ address: string; username: string }>(cfg, "/identity/register", {
    method: "POST", body: JSON.stringify({ username }),
  });
  cfg.handle = out.username;
  await saveConfig(cfg);
  return printJsonOrTable(args, out, (o) =>
    `registered: ${fmtHandle(o.username)}\n` +
    `(usernames are permanent and immutable)\n`,
  );
}

// One-shot stdin line reader. Resolves on first newline. We use this
// (instead of node:readline) to avoid pulling another dep + because we
// only ever need a single answer.
async function readLineFromStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += String(chunk);
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ───────── friends (1-on-1 channels) ───────────────────────────────────────

async function cmdAdd(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu add @handle | <address>\n"); return 1; }
  // Backend resolves both @handle and base58 address — pass either.
  const isAddr = !raw.startsWith("@") && raw.length > 30;
  const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
  const out = await api<any>(cfg, "/friends/add", {
    method: "POST", body: JSON.stringify(body),
  });
  const code = printJsonOrTable(args, out, (o) => {
    const who = fmtHandle(o.target?.username) + (o.target?.address ? ` (${o.target.address.slice(0, 6)}…)` : "");
    if (o.status === "added") return `added ${who}\nchannel_id: ${o.channel_id}\n`;
    if (o.status === "already_friends") return `already friends with ${who}\nchannel_id: ${o.channel_id}\n`;
    if (o.status === "pending") return `request pending — ${who} has auto-accept off\nrequest_id: ${o.request_id}\n`;
    return `status: ${o.status}\n`;
  });

  // Auto-open live feed after add (macOS only, skip with --no-feed).
  if (
    (out.status === "added" || out.status === "already_friends" || out.status === "pending") &&
    process.platform === "darwin" &&
    !args.includes("--no-feed")
  ) {
    try {
      const opened = await openFeedWindow();
      if (opened) process.stdout.write("✓ live feed opened in new window\n");
    } catch {
      process.stdout.write("tip: run `susu feed -f` in another terminal to see live events\n");
    }
  }

  // Signal source guidance — show after first successful add.
  if (out.status === "added" || out.status === "already_friends") {
    const peer = out.target?.username ? `@${out.target.username}` : (raw.startsWith("@") ? raw : "@friend");
    process.stdout.write(
      `\nNext: pipe your trading signals\n` +
      `  echo '{"token":"ETHUSDT","direction":"long","metadata":{"entry_price":2520,"stop_loss":2350,"take_profit":2950}}' | susu push ${peer}\n\n` +
      `  Or from your scanner:\n` +
      `  your_scanner.py | while read line; do echo "$line" | susu push ${peer}; done\n\n` +
      `Your daemon auto-reacts to ${peer}'s signals. Paper trades visible in feed + susu book.\n`,
    );
  }
  return code;
}

async function cmdAccept(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const raw = args[0];
  if (!raw) { process.stderr.write("usage: susu accept @handle\n"); return 1; }
  const isAddr = !raw.startsWith("@") && raw.length > 30;
  const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
  const out = await api<any>(cfg, "/friends/accept", {
    method: "POST", body: JSON.stringify(body),
  });
  return printJsonOrTable(args, out, (o) =>
    `accepted ${fmtHandle(o.friend?.username)}\nchannel_id: ${o.channel_id}\n`,
  );
}

async function cmdFriends(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  if (sub === "remove") {
    const raw = args[1];
    if (!raw) { process.stderr.write("usage: susu friends remove @handle\n"); return 1; }
    const isAddr = !raw.startsWith("@") && raw.length > 30;
    const body = isAddr ? { address: raw } : { username: raw.replace(/^@/, "") };
    const out = await api<any>(cfg, "/friends/remove", {
      method: "POST", body: JSON.stringify(body),
    });
    return printJsonOrTable(args.slice(1), out, (o) => `removed channel ${o.channel_id}\n`);
  }

  // default: list friends + pending incoming + pending outgoing
  const [friends, requests, outgoing] = await Promise.all([
    api<{ friends: any[] }>(cfg, "/friends"),
    api<{ requests: any[] }>(cfg, "/friends/requests").catch(() => ({ requests: [] })),
    api<{ requests: any[] }>(cfg, "/friends/requests/outgoing").catch(() => ({ requests: [] })),
  ]);
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ friends: friends.friends, incoming: requests.requests, outgoing: outgoing.requests }, null, 2) + "\n");
    return 0;
  }
  // Show only @handles. Address + channel_id + request_id are backend
  // identifiers — users navigate purely via @handle.
  const fLines = friends.friends.length === 0
    ? "  (none)"
    : friends.friends.map((f: any) => `  ${fmtHandle(f.friend_username)}`).join("\n");
  const inLines = requests.requests.length === 0
    ? ""
    : `\npending incoming (use \`susu accept @x\` to accept):\n` +
      requests.requests.map((r: any) => `  ${fmtHandle(r.from_username)}`).join("\n") + "\n";
  const outLines = outgoing.requests.length === 0
    ? ""
    : `\npending outgoing (waiting on the other side to accept):\n` +
      outgoing.requests.map((r: any) => `  ${fmtHandle(r.to_username)}`).join("\n") + "\n";
  process.stdout.write(`friends:\n${fLines}\n${inLines}${outLines}`);
  return 0;
}

// ───────── groups (multi-person channels) ──────────────────────────────────

async function cmdGroup(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  const rest = args.slice(1);

  if (sub === "create") {
    // First positional = name (optional). Remaining are @handles to invite.
    const positional = rest.filter((a) => !a.startsWith("-"));
    const name = positional[0] ?? null;
    const invites = positional.slice(1);
    const out = await api<any>(cfg, "/channels", {
      method: "POST", body: JSON.stringify({ name }),
    });
    process.stdout.write(`channel_id: ${out.channel_id}\nowner:      ${out.owner}\n`);
    // Best-effort invite each handle. Resolve @handle → address first.
    for (const handle of invites) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      try {
        const lookup = await api<{ address: string; username: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
        await api(cfg, `/channels/${out.channel_id}/invite`, {
          method: "POST", body: JSON.stringify({ address: lookup.address }),
        });
        process.stdout.write(`  invited @${uname}\n`);
      } catch (e) {
        process.stderr.write(`  failed to invite @${uname}: ${(e as Error).message}\n`);
      }
    }
    return 0;
  }

  if (sub === "members") {
    const id = rest[0];
    if (!id) { process.stderr.write("usage: susu group members <channel_id>\n"); return 1; }
    const out = await api<{ members: any[] }>(cfg, `/channels/${id}/members`);
    return printJsonOrTable(rest, out, (o) =>
      o.members.map((m: any) =>
        `  ${fmtHandle(m.username).padEnd(22)}  joined=${m.joined_at}`,
      ).join("\n") + "\n",
    );
  }

  if (sub === "invite") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group invite <channel_id> @handle\n"); return 1; }
    let address = handle;
    if (handle.startsWith("@") || handle.length < 30) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      const lookup = await api<{ address: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
      address = lookup.address;
    }
    const out = await api(cfg, `/channels/${id}/invite`, {
      method: "POST", body: JSON.stringify({ address }),
    });
    return printJsonOrTable(rest, out, () => `invited ${handle} to ${id}\n`);
  }

  if (sub === "leave") {
    const id = rest[0];
    if (!id) { process.stderr.write("usage: susu group leave <channel_id>\n"); return 1; }
    const out = await api<any>(cfg, `/channels/${id}/leave`, { method: "POST" });
    return printJsonOrTable(rest, out, (o) => {
      if (o.disbanded) return `left ${id} (disbanded — no members left)\n`;
      if (o.ownerHandover) return `left ${id} (ownership auto-elected to ${o.ownerHandover.slice(0, 6)}…)\n`;
      return `left ${id}\n`;
    });
  }

  if (sub === "kick") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group kick <channel_id> @handle\n"); return 1; }
    let address = handle;
    if (handle.startsWith("@") || handle.length < 30) {
      const uname = handle.replace(/^@/, "").toLowerCase();
      const lookup = await api<{ address: string }>(cfg, `/identity/by-username/${uname}`, { auth: false });
      address = lookup.address;
    }
    const out = await api(cfg, `/channels/${id}/kick`, {
      method: "POST", body: JSON.stringify({ address }),
    });
    return printJsonOrTable(rest, out, (o: any) => `kicked ${o.kicked.slice(0, 6)}… from ${id}\n`);
  }

  if (sub === "transfer-owner") {
    const id = rest[0];
    const handle = rest[1];
    if (!id || !handle) { process.stderr.write("usage: susu group transfer-owner <channel_id> @handle\n"); return 1; }
    const body: any = handle.startsWith("@") || handle.length < 30
      ? { username: handle.replace(/^@/, "") }
      : { candidate_address: handle };
    const out = await api<any>(cfg, `/channels/${id}/transfer-owner`, {
      method: "POST", body: JSON.stringify(body),
    });
    return printJsonOrTable(rest, out, (o) => `new owner of ${o.channel_id}: ${o.new_owner.slice(0, 6)}…\n`);
  }

  if (sub === "rename") {
    const id = rest[0];
    const newName = rest.slice(1).join(" ");
    if (!id || !newName) { process.stderr.write("usage: susu group rename <channel_id> <new name>\n"); return 1; }
    const out = await api<any>(cfg, `/channels/${id}/rename`, {
      method: "POST", body: JSON.stringify({ name: newName }),
    });
    return printJsonOrTable(rest, out, (o) => `renamed → "${o.name}"\n`);
  }

  process.stderr.write("usage: susu group [create|members|invite|leave|kick|rename|transfer-owner] ...\n");
  return 1;
}

// ───────── channel meta KV (D13 open protocol) ────────────────────────────

async function cmdMeta(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = args[0] ?? "";
  const id = args[1];
  if (!id) { process.stderr.write("usage: susu meta [get|set|patch] <channel_id> [-j JSON]\n"); return 1; }

  const channelId = await resolveTargetChannel(cfg, id);

  if (sub === "get") {
    const out = await api<{ meta: any }>(cfg, `/channels/${channelId}/meta`);
    return printJsonOrTable(args, out, (o) => JSON.stringify(o.meta, null, 2) + "\n");
  }
  if (sub === "set" || sub === "patch") {
    const jIdx = args.indexOf("-j");
    const altIdx = args.indexOf("--json-body");
    const idx = jIdx >= 0 ? jIdx : altIdx;
    if (idx < 0 || !args[idx + 1]) { process.stderr.write(`usage: susu meta ${sub} <channel_id> -j '<json>'\n`); return 1; }
    let body: any;
    try { body = JSON.parse(args[idx + 1]!); }
    catch (e) { process.stderr.write(`invalid JSON: ${(e as Error).message}\n`); return 1; }
    const method = sub === "set" ? "PUT" : "PATCH";
    const out = await api(cfg, `/channels/${channelId}/meta`, {
      method, body: JSON.stringify(body),
    });
    return printJsonOrTable(args, out, () => `meta ${sub === "set" ? "replaced" : "merged"} for ${channelId}\n`);
  }
  process.stderr.write("usage: susu meta [get|set|patch] <channel_id> [-j JSON]\n");
  return 1;
}

async function readPayload(args: string[]): Promise<any> {
  const mIdx = args.findIndex((a) => a === "-m" || a === "--message");
  if (mIdx >= 0) return { text: args[mIdx + 1] ?? "" };
  const jIdx = args.findIndex((a) => a === "-j" || a === "--json");
  if (jIdx >= 0) {
    const s = args[jIdx + 1];
    if (!s) throw new Error("-j requires a JSON string");
    return JSON.parse(s);
  }
  // stdin
  if (process.stdin.isTTY) throw new Error("provide -m TEXT, -j JSON, or pipe via stdin");
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  buf = buf.trim();
  if (!buf) throw new Error("empty stdin");
  try { return JSON.parse(buf); } catch { return { text: buf }; }
}

async function cmdPush(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu push <@handle | channel_id> [-m TEXT | -j JSON] [-h]\n"); return 1; }
  const id = await resolveTargetChannel(cfg, target);
  // -h / --human: human-takeover convention. Set from_human=true on the
  // payload so the receiving agent (and inbox UIs) can render the message
  // with a HUMAN tag. Server doesn't validate; this is a payload-level
  // convention agreed on in AGENT_DOC.
  const fromHuman = args.includes("-h") || args.includes("--human");
  let payload = await readPayload(args.slice(1).filter((a) => a !== "-h" && a !== "--human"));
  if (fromHuman) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      payload = { text: String(payload), from_human: true };
    } else {
      // S5: warn when -h flag overrides an explicit from_human:false in -j JSON.
      // Flag wins (by design — flag is the most explicit signal of intent),
      // but silent override surprises power users. (G v0.0.4 review 🟡 #4)
      if ((payload as any).from_human === false) {
        process.stderr.write(
          `warning: -h flag overrides "from_human": false in your JSON payload\n`,
        );
      }
      payload = { ...payload, from_human: true };
    }
  }
  try {
    const out = await api<any>(cfg, `/channels/${id}/signals`, {
      method: "POST", body: JSON.stringify(payload),
    });
    return printJsonOrTable(args, out, (o) => {
      const lines = [`signal_id: ${o.signal_id}`, `cost_usd:  ${o.cost_usd}`];
      if (o.allowance_after) {
        const a = o.allowance_after;
        if (a.status === "BETA — free") lines.push(`status:    BETA — free`);
        else if (a.free_credits_usd > 0) lines.push(`credits:   $${Number(a.free_credits_usd).toFixed(2)} (${a.free_credits_calls_remaining} calls)`);
        else lines.push(`allowance: $${Number(a.allowance_usd ?? 0).toFixed(4)} (${a.estimated_calls_remaining ?? "?"} calls remaining)`);
      }
      return lines.join("\n") + "\n";
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const b = e.body ?? {};
      const creditNote = b.free_credits_exhausted ? " (free credits exhausted)" : "";
      process.stderr.write(
        `insufficient_allowance${creditNote}: $${Number(b.allowance_usd ?? 0).toFixed(4)} < $${Number(b.required_usd ?? 0).toFixed(4)}\n` +
        `run \`susu approve\` (or open ${b.approve_again_url ?? "https://susurration.xyz/approve"}) to top up.\n`,
      );
      return 1;
    }
    throw e;
  }
}

async function cmdReact(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const id = args[0];
  if (!id) { process.stderr.write("usage: susu react <signal_id> [-m TEXT | -j JSON]\n"); return 1; }
  const payload = await readPayload(args.slice(1));
  const isAuto = args.includes("--auto");
  try {
    const out = await api<any>(cfg, `/signals/${id}/reactions`, {
      method: "POST", body: JSON.stringify({ payload, is_auto: isAuto }),
    });
    return printJsonOrTable(args, out, (o) => {
      const lines = [`reaction_id: ${o.reaction_id}`, `cost_usd:    ${o.cost_usd}`];
      if (o.allowance_after) {
        const a = o.allowance_after;
        if (a.status === "BETA — free") lines.push(`status:      BETA — free`);
        else if (a.free_credits_usd > 0) lines.push(`credits:     $${Number(a.free_credits_usd).toFixed(2)} (${a.free_credits_calls_remaining} calls)`);
        else lines.push(`allowance:   $${Number(a.allowance_usd ?? 0).toFixed(4)}`);
      }
      return lines.join("\n") + "\n";
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const b = e.body ?? {};
      const creditNote = b.free_credits_exhausted ? " (free credits exhausted)" : "";
      process.stderr.write(
        `insufficient_allowance${creditNote}: $${Number(b.allowance_usd ?? 0).toFixed(4)} < $${Number(b.required_usd ?? 0).toFixed(4)}\n` +
        `run \`susu approve\` to top up.\n`,
      );
      return 1;
    }
    throw e;
  }
}

async function cmdSignals(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu signals <@handle | channel_id>\n"); return 1; }
  const id = await resolveTargetChannel(cfg, target);
  const out = await api<{ signals: any[] }>(cfg, `/channels/${id}/signals?limit=50`);
  return printJsonOrTable(args, out, (o) =>
    o.signals.map((s: any) => {
      const who = s.from_username ? `@${s.from_username}` : "(unregistered)";
      return `${fmtTimePlain(s.created_at)}  ${who.padEnd(20)}  ${JSON.stringify(s.payload)}`;
    }).join("\n") + "\n",
  );
}

// Result of one stream attempt — drives reconnect decision in cmdWatch.
//   - retryAfterMs lets server-imposed cooldowns (HTTP 429 with Retry-After)
//     override the default backoff schedule, avoiding tight reconnect storms
//     that would just hit the cap again.
type WatchResult =
  | { kind: "ejected" }
  | { kind: "auth_error" }
  | { kind: "disconnected"; retryAfterMs?: number };

async function cmdWatch(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const target = args[0];
  if (!target) { process.stderr.write("usage: susu watch <@handle | channel_id>\n"); return 1; }
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const id = await resolveTargetChannel(cfg, target);
  const url = `${cfg.api_url.replace(/\/$/, "")}/channels/${id}/signals/stream`;
  process.stderr.write(`tailing ${id} (Ctrl-C to exit)\n`);

  // Ctrl-C → process.exit handles cleanup; user-initiated abort skips reconnect.
  let userAborted = false;
  const onSigint = () => { userAborted = true; process.exit(0); };
  process.on("SIGINT", onSigint);

  // Reconnect with exponential backoff: 1s → 2s → 4s → ... cap 30s.
  // Reset to 1s whenever the previous connection lasted ≥ 30s (treats it as a
  // transient blip, not a persistent failure).
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;
  const STABLE_THRESHOLD_MS = 30_000;

  try {
    while (!userAborted) {
      const startedAt = Date.now();
      const result = await runOneWatchStream(url, cfg.token);
      const elapsed = Date.now() - startedAt;

      if (result.kind === "ejected") return 0;
      if (result.kind === "auth_error") {
        process.stderr.write(
          "your session has expired. Run `susu login` to re-authenticate.\n",
        );
        return 1;
      }
      // result.kind === "disconnected" → reconnect

      if (userAborted) break;
      if (elapsed >= STABLE_THRESHOLD_MS) backoffMs = 1000;
      // Server-imposed cooldown (e.g. 429 too_many_streams) wins over our
      // default schedule — reconnecting before Retry-After just rejects again.
      const sleepMs = result.retryAfterMs ?? backoffMs;
      process.stderr.write(`(disconnected, reconnecting in ${(sleepMs / 1000).toFixed(1)}s...)\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  return 0;
}

// One SSE attempt. Returns:
//   - "ejected": server told us we're kicked → caller should NOT reconnect.
//   - "auth_error": 401/403 → caller should NOT reconnect.
//   - "disconnected": any other failure (network blip, server hangup, parse
//     error) → caller SHOULD reconnect.
async function runOneWatchStream(url: string, token: string): Promise<WatchResult> {
  let resp;
  try {
    // S5: CLI uses Authorization header instead of ?stream_token. node fetch
    // supports custom headers on SSE; only browsers (EventSource) need the
    // query-string fallback. Avoids token leakage to platform access logs
    // (G v0.0.4 review 🟡 #5).
    resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (process.env.SUSU_DEBUG) {
      process.stderr.write(`(SUSU_DEBUG fetch failed: ${(err as Error)?.message ?? err})\n`);
    }
    return { kind: "disconnected" };
  }
  if (resp.status === 401 || resp.status === 403) {
    process.stderr.write(`stream error: HTTP ${resp.status}\n`);
    return { kind: "auth_error" };
  }
  if (resp.status === 429) {
    // Server says we're over the per-user concurrent SSE cap. Honor
    // Retry-After (seconds) so we don't tight-loop into another 429.
    const ra = Number(resp.headers.get("retry-after") ?? "10");
    const retryAfterMs = Number.isFinite(ra) ? Math.max(ra * 1000, 1000) : 10_000;
    process.stderr.write(`stream error: HTTP 429 too_many_streams (retry after ${(retryAfterMs / 1000).toFixed(0)}s)\n`);
    return { kind: "disconnected", retryAfterMs };
  }
  if (!resp.ok || !resp.body) {
    process.stderr.write(`stream error: HTTP ${resp.status}\n`);
    return { kind: "disconnected" };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ejected = false;

  try {
    // SSE parse: messages separated by blank line, fields prefixed `field: `.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? "";
      for (const block of parts) {
        let event = "message", data = "";
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "ping") continue;
        if (event === "open") { process.stderr.write("connected\n"); continue; }
        if (event === "ejected" && data) {
          try {
            const ej = JSON.parse(data);
            process.stderr.write(`(ejected — reason: ${ej.reason ?? "unknown"})\n`);
          } catch { process.stderr.write(`(ejected: ${data})\n`); }
          ejected = true;
          continue;
        }
        // BETA-1.c: backend now broadcasts signal / reaction / channel_* /
        // friend_* / channel_invited / channel_created on the same channel
        // SSE. renderWireEvent dispatches by `kind`. Unknown kinds (future
        // event types) → null → silent skip (forward-compatible).
        if (data) {
          try {
            const e = JSON.parse(data);
            const line = renderWireEvent(e);
            if (line) process.stdout.write(line + "\n");
          } catch (err) {
            if (process.env.SUSU_DEBUG) {
              process.stderr.write(`(SUSU_DEBUG parse error event=${event}: ${err})\n${data}\n`);
            }
          }
        }
      }
    }
  } catch (err) {
    // reader.read() threw (most commonly TypeError: terminated when the
    // underlying socket dies — undici's standard abort error). Fall through
    // and let the caller reconnect with backoff.
    if (process.env.SUSU_DEBUG) {
      process.stderr.write(`(SUSU_DEBUG stream broken: ${(err as Error)?.message ?? err})\n`);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return ejected ? { kind: "ejected" } : { kind: "disconnected" };
}

// ───────── feed / inbox (cross-channel views) ─────────────────────────────
//
// `susu feed`         → plain log of last N messages across all channels
// `susu feed -f`      → bootstrap N + live SSE tail
// `susu feed --bubbles -f` → bubble UI (chat-app feel) + live tail
// `susu inbox`        → opens a fresh macOS Terminal window running the
//                       bubble version of `feed -f`, then returns. Designed
//                       so the human can leave it in another desktop / on a
//                       second monitor while they keep working elsewhere.
//
// Channel labels are computed server-side (peer @handle for 1-on-1, group
// name for groups), so the client just renders.

interface FeedRow {
  signal_id: string;
  channel_id: string;
  from_address: string;
  from_username: string | null;
  payload: any;
  created_at: string;
  channel_name?: string | null;
  peer?: { address: string; username: string | null } | null;
}

function channelLabel(row: FeedRow, myAddress: string): string {
  if (row.channel_name) return row.channel_name;
  if (row.peer?.username) return `@${row.peer.username}`;
  // Fall back: 1-on-1 with unregistered peer → first 6 chars of channel_id.
  return row.channel_id.slice(0, 8);
}

/** "Who is this message addressed to" — used as the right-hand side of
 *  `<from> → <to>`. For 1-on-1, the recipient depends on who sent (peer
 *  if I sent, me if peer sent). For groups, it's the group name. */
function recipientLabel(row: FeedRow, myAddress: string, myUsername: string | null): string {
  if (row.channel_name) return row.channel_name; // group
  if (row.from_address === myAddress) {
    return row.peer?.username ? `@${row.peer.username}` : "(unregistered)";
  }
  return myUsername ? `@${myUsername}` : "me";
}

// ANSI helpers — color-code participants. Pure ANSI, no deps. Falls back
// to plain when stdout isn't a TTY (e.g. piped to a file).
const PALETTE = ["\x1b[35m", "\x1b[36m", "\x1b[33m", "\x1b[34m", "\x1b[31m", "\x1b[95m", "\x1b[96m", "\x1b[93m"];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";

function colorFor(handle: string): string {
  if (!process.stdout.isTTY) return "";
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
function dim(s: string): string { return process.stdout.isTTY ? `${DIM}${s}${RESET}` : s; }
function bold(s: string): string { return process.stdout.isTTY ? `${BOLD}${s}${RESET}` : s; }

// Terminal display-width math. CJK / fullwidth / common emoji = 2 cols;
// everything else = 1 col. ANSI escapes are stripped first. We need this
// because `String#length` counts code units, which under-counts CJK and
// breaks bubble box alignment (right border drifts left, padding too short).
function displayWidth(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3041 && code <= 0x33FF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0xA000 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x1F300 && code <= 0x1F9FF)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padEndDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

/** Greedy wrap on display-width (CJK-aware), preserving existing newlines. */
function wrapByDisplayWidth(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para.length === 0) { out.push(""); continue; }
    let buf = "";
    let bufW = 0;
    for (const ch of para) {
      const cw = displayWidth(ch);
      if (bufW + cw > maxWidth && buf.length > 0) {
        out.push(buf);
        buf = ch;
        bufW = cw;
      } else {
        buf += ch;
        bufW += cw;
      }
    }
    if (buf.length > 0) out.push(buf);
  }
  return out;
}

function renderPayloadCompact(payload: any): string {
  // S5: strip ANSI / control chars at render time (defense-in-depth — server
  // also strips on push, but this protects against legacy data and any code
  // path where payload reaches a terminal without going through the new push
  // handler). See shared/strip-control.ts.
  payload = stripControlCharsDeep(payload);
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && "text" in payload && Object.keys(payload).length <= 2) {
    return String(payload.text);
  }
  return JSON.stringify(payload);
}

// Format timestamps in UTC (anchor for global team — no per-user timezone
// drift). Plain log: full date+time; bubble: time-of-day only (the bootstrap
// banner already gives the date context).
function fmtTimePlain(iso: string): string {
  // 2026-04-30T11:27:55.521Z → "2026-04-30 11:27:55 UTC"
  return iso.replace(/T/, " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}
function fmtTimeBubble(iso: string): string {
  // 2026-04-30T11:27:55.521Z → "11:27:55 UTC"
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return (m ? m[1] : iso) + " UTC";
}

// Render a single wire event to a one-line plain string. Covers all event
// kinds the backend SSE emits (signal / reaction / channel_* / friend_* /
// channel_invited / channel_created). Unknown kinds → null (caller should
// skip silently — forward-compat with future event types).
//
// Used by `susu watch` (channel SSE, no channel-meta enrichment) and as the
// non-signal-event fallback in `susu feed -f` (signal events still go through
// renderPlainLine / renderBubble for consistent label formatting).
function renderWireEvent(e: any): string | null {
  e = stripControlCharsDeep(e);
  if (!e || typeof e !== "object" || typeof e.kind !== "string") return null;
  const t = dim(fmtTimePlain(e.created_at ?? e.ts ?? ""));
  const w = (addr: string | null | undefined, name: string | null | undefined): string =>
    name ? `@${stripControlChars(String(name))}` : (addr ? String(addr).slice(0, 8) + "…" : "?");
  const short = (id: string | undefined): string => id ? String(id).slice(0, 8) : "";
  switch (e.kind) {
    case "signal":
      return `${t}  ${w(e.from_address, e.from_username).padEnd(20)}  ${JSON.stringify(e.payload)}`;
    case "reaction": {
      const rp = e.payload ?? {};
      const val = rp.value ?? "?";
      const sf = typeof rp.size_factor === "number" ? ` sf=${rp.size_factor}` : "";
      const note = rp.note ? ` "${stripControlChars(String(rp.note))}"` : "";
      const valColor = val === "+1" ? "\x1b[32m" : val === "-1" ? "\x1b[31m" : "";
      const valStr = process.stdout.isTTY ? `${valColor}${val}\x1b[0m` : val;
      return `${t}  ${w(e.from_address, e.from_username).padEnd(20)}  ↳ ${valStr}${sf}${note}`;
    }
    case "channel_member_added":
      return `${t}  ${dim("[member +]")}          ${w(e.address, e.username)} joined (by ${w(e.by, null)})`;
    case "channel_member_removed":
      return `${t}  ${dim("[member −]")}          ${w(e.address, e.username)} ${e.reason}${e.by ? " by " + w(e.by, null) : ""}`;
    case "channel_meta_changed":
      return `${t}  ${dim(`[meta ${e.method}]`)}         by ${w(e.by, null)}${e.size_bytes ? ` (${e.size_bytes}B)` : ""}`;
    case "channel_owner_transferred":
      return `${t}  ${dim("[owner →]")}           ${w(e.from_address, null)} → ${w(e.to_address, null)} (${e.reason})`;
    case "channel_renamed":
      return `${t}  ${dim("[renamed]")}           "${e.old_name ?? "?"}" → "${e.new_name}" by ${w(e.by, null)}`;
    case "friend_request":
      return `${t}  ${dim("[friend req]")}        from ${w(e.from_address, e.from_username)} (req ${short(e.request_id)})`;
    case "friend_accepted":
      return `${t}  ${dim("[friend ✓]")}          ${w(e.with_address, e.with_username)}${e.auto ? " (auto)" : ""} → channel ${short(e.channel_id)}`;
    case "friend_removed":
      return `${t}  ${dim("[unfriended]")}        by ${w(e.by_address, e.by_username)} (channel ${short(e.channel_id)} closed)`;
    case "channel_invited":
      return `${t}  ${dim("[invited]")}           by ${w(e.by, e.by_username)} → ${e.channel_name ?? short(e.channel_id)}`;
    case "channel_created":
      return `${t}  ${dim("[created]")}           ${e.is_group ? "group" : "1on1"} ${e.name ?? short(e.channel_id)}`;
    case "paper_open": {
      const sign = e.direction === "long" ? "📈" : "📉";
      return `${t}  ${sign} ${bold("[OPEN]")}  #${e.id} ${e.token} ${e.direction} ${e.leverage}x  entry=${e.entry_price}  SL=${e.stop_loss} TP=${e.take_profit}  $${Number(e.position_usd).toFixed(2)} from ${e.peer}`;
    }
    case "paper_close": {
      const pnl = Number(e.pnl_pct ?? 0);
      const usd = Number(e.pnl_usd ?? 0);
      const pnlColor = pnl >= 0 ? "\x1b[32m" : "\x1b[31m";
      const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% ($${usd >= 0 ? "+" : ""}${usd.toFixed(2)})`;
      return `${t}  ${bold("[CLOSE]")} #${e.id} ${e.token}  ${e.exit_reason}  exit=${e.exit_price}  ${pnlColor}${pnlStr}\x1b[0m  best=${Number(e.best_pnl_pct ?? 0) >= 0 ? "+" : ""}${Number(e.best_pnl_pct ?? 0).toFixed(2)}%`;
    }
    case "paper_skip": {
      const reason = e.reason ?? "unknown";
      const token = e.token ?? "?";
      const peer = e.peer ?? "?";
      return `${t}  ${dim("[SKIP]")}  ${token} from ${peer}: ${reason}`;
    }
    default:
      return null;
  }
}

function renderPlainLine(row: FeedRow, myAddress: string, myUsername: string | null): string {
  // username has its own server-enforced charset (5-20 chars [a-z0-9_-])
  // so it's safe; we strip anyway as a belt-and-braces measure.
  const who = row.from_username ? `@${stripControlChars(row.from_username)}` : "(unregistered)";
  const to = recipientLabel(row, myAddress, myUsername);
  const isHuman = row.payload && typeof row.payload === "object" && row.payload.from_human === true;
  const tag = isHuman ? (process.stdout.isTTY ? `\x1b[1;33m[HUMAN]\x1b[0m ` : `[HUMAN] `) : "";
  return `${dim(fmtTimePlain(row.created_at))}  ${tag}${padEndDisplay(who, 18)} → ${padEndDisplay(to, 18)}  ${renderPayloadCompact(row.payload)}`;
}

function renderBubble(row: FeedRow, myAddress: string, myUsername: string | null, termWidth: number): string {
  const fromMe = row.from_address === myAddress;
  const who = row.from_username ? `@${row.from_username}` : "(unregistered)";
  const time = fmtTimeBubble(row.created_at);
  const isHuman = row.payload && typeof row.payload === "object" && row.payload.from_human === true;
  const tag = isHuman ? "[HUMAN] " : "";
  // Only emit color codes on a real TTY; piped/redirected output stays plain.
  const color = !process.stdout.isTTY ? "" : (fromMe ? GREEN : colorFor(who));
  const dot = process.stdout.isTTY ? `${color}●${RESET}` : "●";

  const text = renderPayloadCompact(row.payload);
  // Bubble takes ~60% of terminal width; floor at 20 cols so very narrow
  // terminals still get a usable shape.
  const maxBubbleInner = Math.max(16, Math.floor(termWidth * 0.6) - 4);

  const wrapped = wrapByDisplayWidth(text, maxBubbleInner);
  const innerWidth = Math.max(...wrapped.map((l) => displayWidth(l)), 0);
  const top    = "┌" + "─".repeat(innerWidth + 2) + "┐";
  const bottom = "└" + "─".repeat(innerWidth + 2) + "┘";
  const body   = wrapped.map((l) => "│ " + padEndDisplay(l, innerWidth) + " │");
  const bubbleVisualWidth = innerWidth + 4; // 2 borders + 2 spaces

  // HUMAN tag rendered prominently — bold + yellow if TTY (eye-catching but
  // not "ALERT" red, since human-takeover is normal protocol behavior).
  const humanTag = isHuman
    ? (process.stdout.isTTY ? `\x1b[1;33m[HUMAN]\x1b[0m ` : `[HUMAN] `)
    : "";

  const lines: string[] = [];
  if (fromMe) {
    // Right-aligned: header + bubble lines pushed to right edge.
    const header = `${dim(time)}  ${humanTag}${color}${who}${process.stdout.isTTY ? RESET : ""} ${dot}`;
    const headerVisualWidth = displayWidth(header);
    lines.push(" ".repeat(Math.max(0, termWidth - headerVisualWidth)) + header);
    for (const l of [top, ...body, bottom]) {
      lines.push(
        " ".repeat(Math.max(0, termWidth - bubbleVisualWidth)) +
        (process.stdout.isTTY ? color + l + RESET : l),
      );
    }
  } else {
    // Left-aligned.
    const header = `${dot} ${color}${who}${process.stdout.isTTY ? RESET : ""}  ${humanTag}${dim(time)}  ${dim("→ " + recipientLabel(row, myAddress, myUsername))}`;
    lines.push(header);
    for (const l of [top, ...body, bottom]) {
      lines.push("   " + (process.stdout.isTTY ? color + l + RESET : l));
    }
  }
  return lines.join("\n");
}

function loadRecentPaperEvents(filePath: string, limit: number, since?: string): any[] {
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    const events: any[] = [];
    const sinceMs = since ? Date.parse(since) : 0;
    for (const ln of lines) {
      try {
        const evt = JSON.parse(ln);
        if (typeof evt.kind !== "string" || !evt.kind.startsWith("paper_")) continue;
        const ts = evt.ts ?? evt.created_at;
        if (sinceMs && ts && Date.parse(ts) < sinceMs) continue;
        events.push(evt);
      } catch { /* skip malformed */ }
    }
    return events.slice(-limit);
  } catch { return []; }
}

function mergeTimelines(server: any[], paper: any[]): any[] {
  const getTs = (e: any): number => {
    const raw = e.created_at ?? e.ts ?? e.opened_at ?? "";
    return Date.parse(raw) || 0;
  };
  const combined = [...server, ...paper];
  combined.sort((a, b) => getTs(a) - getTs(b));
  return combined;
}

// ────── persistent position bar (feed footer) ──────

function loadOpenPaperPositions(): any[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const tradesPath = `${configDir()}/paper_trades.json`;
  try {
    const data = JSON.parse(fs.readFileSync(tradesPath, "utf8"));
    return (data.trades ?? []).filter((t: any) => t.status === "open");
  } catch { return []; }
}

async function fetchBinancePricesForBar(symbols: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (symbols.length === 0) return prices;
  try {
    const resp = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return prices;
    const data = (await resp.json()) as Array<{ symbol: string; price: string }>;
    const want = new Set(symbols);
    for (const item of data) {
      if (want.has(item.symbol)) prices.set(item.symbol, parseFloat(item.price));
    }
  } catch { /* network error — bar shows "…" for prices */ }
  return prices;
}

/**
 * Persistent position bar at the bottom of the feed terminal.
 * Uses ANSI scroll regions to reserve space below the feed output.
 * Refreshes live prices from Binance every 15 seconds.
 *
 * The scroll region is set **synchronously** on first call so that all
 * subsequent feed output is constrained to the scroll region.  Price
 * data is fetched asynchronously and back-filled on first tick.
 *
 * Returns a cleanup function that resets the terminal scroll region.
 */
function startPositionBar(): () => void {
  if (!process.stdout.isTTY) return () => {};

  let reservedLines = 0;
  let active = true;

  const calcBarLines = (nPositions: number): number =>
    nPositions === 0 ? 0 : 1 + Math.min(nPositions, 4) + (nPositions > 4 ? 1 : 0);

  const applyScrollRegion = (needed: number) => {
    const rows = process.stdout.rows ?? 24;
    if (needed === reservedLines) return;
    reservedLines = needed;
    if (needed === 0) {
      process.stdout.write("\x1b[r"); // reset scroll region to full terminal
    } else {
      process.stdout.write(`\x1b[1;${rows - reservedLines}r`);
      // Move cursor inside the scroll region so subsequent output stays there.
      process.stdout.write(`\x1b[${rows - reservedLines};1H`);
    }
  };

  const drawBar = (positions: any[], prices: Map<string, number>) => {
    if (reservedLines === 0) return;
    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 80;
    const termWidth = Math.max(40, Math.min(120, cols));

    const posLines: string[] = [];
    for (const pos of positions.slice(0, 4)) {
      const cp = prices.get(pos.token) ?? null;
      const sign = pos.direction === "long" ? "📈" : "📉";
      if (cp !== null) {
        const delta = pos.direction === "long"
          ? (cp - pos.entry_price) / pos.entry_price
          : (pos.entry_price - cp) / pos.entry_price;
        const pnlPct = delta * pos.leverage * 100;
        const pnlUsd = delta * pos.notional_usd;
        const c = pnlPct >= 0 ? "\x1b[32m" : "\x1b[31m";
        const pnl = `${c}${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% ($${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)})${RESET}`;
        posLines.push(`  ${sign} #${pos.id} ${pos.token} ${pos.direction} ${pos.leverage}x  entry=${pos.entry_price}  now=${cp}  ${pnl}`);
      } else {
        posLines.push(`  ${sign} #${pos.id} ${pos.token} ${pos.direction} ${pos.leverage}x  entry=${pos.entry_price}  ${dim("loading…")}`);
      }
    }
    if (positions.length > 4) {
      posLines.push(dim(`  ... +${positions.length - 4} more`));
    }

    process.stdout.write("\x1b7"); // save cursor (DEC)
    const separator = dim("─── positions " + "─".repeat(Math.max(0, termWidth - 15)));
    for (let i = 0; i < reservedLines; i++) {
      process.stdout.write(`\x1b[${rows - reservedLines + 1 + i};1H\x1b[2K`);
      if (i === 0) process.stdout.write(separator);
      else process.stdout.write(posLines[i - 1] ?? "");
    }
    process.stdout.write("\x1b8"); // restore cursor (DEC)
  };

  // ── Synchronous init: set scroll region immediately if positions exist ──
  const initialPositions = loadOpenPaperPositions();
  const needed = calcBarLines(initialPositions.length);
  if (needed > 0) {
    applyScrollRegion(needed);
    // Draw placeholder bar (no prices yet — "loading…")
    drawBar(initialPositions, new Map());
  }

  // ── Async refresh: fetch prices and re-draw ──
  const redraw = async () => {
    if (!active) return;

    const positions = loadOpenPaperPositions();
    const newNeeded = calcBarLines(positions.length);

    if (newNeeded !== reservedLines) {
      applyScrollRegion(newNeeded);
    }
    if (positions.length === 0) return;

    const symbols = [...new Set(positions.map((p: any) => p.token))];
    const prices = await fetchBinancePricesForBar(symbols);
    if (!active) return; // could have been cleaned up during fetch

    drawBar(positions, prices);
  };

  // First async tick fills in real prices
  redraw();

  // Refresh every 15 seconds
  const timer = setInterval(redraw, 15_000);

  // Handle terminal resize
  const onResize = () => {
    reservedLines = 0; // force scroll region recalculation
    redraw();
  };
  process.stdout.on("resize", onResize);

  return () => {
    active = false;
    clearInterval(timer);
    process.stdout.removeListener("resize", onResize);
    if (reservedLines > 0) {
      process.stdout.write("\x1b[r"); // reset scroll region
    }
  };
}

async function cmdFeed(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in (run `susu login`)\n"); return 2; }

  const snapshot = args.includes("--snapshot") || args.includes("--no-follow");
  const follow = !snapshot;
  const bubbles = args.includes("--bubbles");
  const since = pickFlag(args, "--since");

  // Defensive parsing — server validates too (returns 400) but failing fast
  // gives a cleaner CLI error than waiting for an HTTP round-trip.
  const rawLimit = pickFlag(args, "--limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isFinite(limit)) {
    process.stderr.write(`error: --limit must be a finite number (got "${rawLimit}")\n`);
    return 1;
  }
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    process.stderr.write(`error: --since must be ISO 8601 (e.g. 2026-04-30T00:00:00Z), got "${since}"\n`);
    return 1;
  }

  const myAddress = String(cfg.address ?? "");
  const myUsername = (cfg.handle as string | undefined) ?? null;
  const termWidth = Math.max(40, Math.min(120, process.stdout.columns ?? 80));

  function renderRow(row: FeedRow) {
    if (bubbles) process.stdout.write(renderBubble(row, myAddress, myUsername, termWidth) + "\n");
    else process.stdout.write(renderPlainLine(row, myAddress, myUsername) + "\n");
  }

  // 1. History bootstrap — server events + local paper trading events.
  const qs = new URLSearchParams();
  qs.set("limit", String(Math.min(Math.max(limit, 1), 200)));
  if (since) qs.set("since", since);
  const hist = await api<{ events?: any[]; signals: FeedRow[] }>(cfg, `/signals/feed?${qs.toString()}`);
  const raw = hist.events ?? hist.signals;
  const serverEvents = [...raw].reverse();

  // Merge local paper_* events into timeline so bootstrap shows the full picture.
  const eventLogPath = `${(process.env.SUSU_HOME ?? `${process.env.HOME}/.susu`)}/events.jsonl`;
  const paperEvents = loadRecentPaperEvents(eventLogPath, limit, since);
  const ordered = mergeTimelines(serverEvents, paperEvents);

  if (bubbles && process.stdout.isTTY) {
    process.stdout.write(`${dim("─── inbox · showing last " + ordered.length + " events ────────────────────────")}\n`);
    process.stdout.write(`${dim("─── for older runs: susu feed --since YYYY-MM-DD ────────────────────")}\n`);
    process.stdout.write(`${dim("─── tip: Terminal > Settings > Profiles > Window > Scrollback: Unlimited")}\n\n`);
  }
  for (const row of ordered) {
    if (row.kind && typeof row.kind === "string" && row.kind.startsWith("paper_")) {
      const line = renderWireEvent(row);
      if (line) process.stdout.write(line + "\n");
    } else if (row.kind === "reaction") {
      const line = renderWireEvent(row);
      if (line) process.stdout.write(line + "\n");
    } else {
      renderRow(row);
      if (bubbles) process.stdout.write("\n");
    }
  }

  if (!follow) return 0;

  // 1b. Start persistent position bar (open positions + live P&L at bottom of terminal).
  const cleanupPositionBar = startPositionBar();
  process.on("exit", () => cleanupPositionBar());

  // 2. Live tail via SSE on /signals/feed/stream + local event log for paper trading.
  if (bubbles && process.stdout.isTTY) {
    process.stdout.write(`${dim("─── live · Ctrl-C to exit ──────────────────────────────────────────")}\n\n`);
  } else {
    process.stderr.write("─── live (Ctrl-C to exit) ───────────────\n");
  }

  // 2a. Tail local event log for paper_* events (written by daemon).
  tailLocalEvents(eventLogPath, renderWireEvent);

  // 2b. SSE stream from server with auto-reconnect.
  const url = `${cfg.api_url.replace(/\/$/, "")}/signals/feed/stream`;
  let backoff = 1000;

  while (true) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if (!resp.ok || !resp.body) {
        process.stderr.write(`stream error: HTTP ${resp.status}\n`);
        if (resp.status === 401 || resp.status === 403) return 1;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1000;
      process.stderr.write("connected\n");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() ?? "";
        for (const block of parts) {
          let event = "message", data = "";
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "ping") continue;
          if (event === "open") continue;
          if (event === "ejected" && data) {
            try {
              const ej = JSON.parse(data);
              process.stderr.write(
                `(ejected from ${ej.channel_id ?? "channel"} — reason: ${ej.reason ?? "unknown"})\n`,
              );
            } catch { process.stderr.write(`(ejected: ${data})\n`); }
            continue;
          }
          if (data) {
            try {
              const e = JSON.parse(data);
              if (e.kind === "signal") {
                renderRow(e as FeedRow);
                if (bubbles) process.stdout.write("\n");
              } else {
                const line = renderWireEvent(e);
                if (line) process.stdout.write(line + "\n");
              }
            } catch (err) {
              if (process.env.SUSU_DEBUG) {
                process.stderr.write(`(SUSU_DEBUG feed parse error event=${event}: ${err})\n`);
              }
            }
          }
        }
      }
    } catch (err) {
      if (process.env.SUSU_DEBUG) {
        process.stderr.write(`(stream error: ${(err as Error)?.message ?? err})\n`);
      }
    }
    process.stderr.write(`(disconnected, reconnecting in ${(backoff / 1000).toFixed(0)}s...)\n`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

function tailLocalEvents(
  filePath: string,
  renderer: (e: any) => string | null,
): void {
  const fs = require("node:fs") as typeof import("node:fs");
  let offset = 0;
  try {
    offset = fs.statSync(filePath).size;
  } catch { /* file doesn't exist yet */ }

  const readNew = () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= offset) return;
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      const lines = buf.toString("utf8").split("\n");
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try {
          const evt = JSON.parse(ln);
          if (typeof evt.kind !== "string" || !evt.kind.startsWith("paper_")) continue;
          const rendered = renderer(evt);
          if (rendered) process.stdout.write(rendered + "\n");
        } catch { /* skip malformed */ }
      }
    } catch { /* file gone or unreadable */ }
  };

  setInterval(readNew, 1000);
}

function pickFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

/** Check if a feed window was already opened (by process or lock file). */
async function isFeedRunning(): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync("pgrep -f 'feed --bubbles'", { encoding: "utf8", timeout: 3000 });
    const pids = out.trim().split("\n").filter((p) => p && Number(p) !== process.pid);
    if (pids.length > 0) return true;
  } catch { /* no match */ }
  // Also check lock file — covers the race between osascript launch and process start.
  const fs = await import("node:fs");
  const lockPath = (process.env.SUSU_HOME ?? `${process.env.HOME}/.susu`) + "/feed.lock";
  try {
    const ts = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (Date.now() - ts < 30_000) return true; // opened within last 30s
  } catch { /* no lock */ }
  return false;
}

/** Open a live feed in a new macOS Terminal window. Skips if one is already running. Returns true if opened. */
async function openFeedWindow(limit = "200"): Promise<boolean> {
  if (await isFeedRunning()) return false;
  // Write lock file before launching.
  const fsSync = await import("node:fs");
  const lockPath = (process.env.SUSU_HOME ?? `${process.env.HOME}/.susu`) + "/feed.lock";
  try { fsSync.writeFileSync(lockPath, String(Date.now())); } catch { /* best effort */ }
  const argv1 = process.argv[1] ?? "susu";
  const binPath = (argv1.startsWith("/") && !argv1.endsWith(".ts") && !argv1.endsWith(".js"))
    ? argv1 : "susu";
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "susu-inbox-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const lines = ["#!/bin/zsh"];
  if (process.env.SUSU_API_URL) {
    lines.push(`export SUSU_API_URL=${shellQuote(process.env.SUSU_API_URL)}`);
  }
  if (process.env.SUSU_HOME) {
    lines.push(`export SUSU_HOME=${shellQuote(process.env.SUSU_HOME)}`);
  }
  lines.push(`exec ${shellQuote(binPath)} feed --bubbles -f --limit ${limit}`);
  await fs.writeFile(scriptPath, lines.join("\n") + "\n", { mode: 0o700 });
  const { spawn } = await import("node:child_process");
  const escaped = scriptPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const osa = `tell application "Terminal"\n  activate\n  do script "${escaped}"\nend tell`;
  const child = spawn("osascript", ["-e", osa], { stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return true;
}

async function cmdInbox(args: string[]): Promise<number> {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "susu inbox is macOS-only convenience.\n" +
      "On Linux/Windows, open any terminal and run:\n" +
      "  susu feed --bubbles -f\n",
    );
    return 1;
  }
  const limit = pickFlag(args, "--limit") ?? "200";
  if (!/^\d{1,4}$/.test(limit)) {
    process.stderr.write(`error: --limit must be a small positive integer, got "${limit}"\n`);
    return 1;
  }
  await openFeedWindow(limit);
  process.stdout.write("opened inbox in a new Terminal window.\n");
  return 0;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_/.:=@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ───────── billing (non-custodial: SPL Approve + on-chain delegate) ───────

async function cmdAllowance(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const out = await api<any>(cfg, "/billing/allowance");
  return printJsonOrTable(args, out, (o) => {
    if (o.status === "BETA — free") {
      return (
        `status:  BETA — free (every push and react is free)\n` +
        `(when paid mode flips on, your first push will return 402 + an approve URL)\n`
      );
    }
    const creditLine = o.free_credits_usd > 0
      ? `free_credits:    $${Number(o.free_credits_usd).toFixed(2)} (${o.free_credits_calls_remaining} calls)\n`
      : `free_credits:    exhausted\n`;
    return (
      `status:          ${o.status}\n` +
      `rate_per_call:   $${o.rate_usd_per_call}\n` +
      creditLine +
      `allowance_usd:   $${Number(o.allowance_usd ?? 0).toFixed(4)}\n` +
      `calls_remaining: ${o.estimated_calls_remaining ?? "?"} (credits + allowance)\n` +
      `cluster:         ${o.cluster}\n` +
      `\nApprove top-up:  ${o.approve_again_url}\n` +
      `(or run: susu approve [<amount_usd>])\n`
    );
  });
}

async function cmdApprove(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const amount = Number(args[0] ?? 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    process.stderr.write("usage: susu approve [<amount_usd=100>]\n"); return 1;
  }
  const out = await api<any>(cfg, "/billing/approve-tx", {
    method: "POST", body: JSON.stringify({ amount_usd: amount }),
  });
  // CLI cannot sign a Solana tx by itself — direct user to the web flow which
  // wraps Phantom signMessage / signAndSendTransaction.
  return printJsonOrTable(args, out, (o) => {
    const url = `https://susurration.xyz/approve?amount=${amount}`;
    return (
      `Approve tx built (base64 ${String(o.tx_b64 ?? "").length}b).\n` +
      `Open the web flow to sign in Phantom:\n  ${url}\n` +
      `(CLI cannot sign Solana txs directly — keypair format differs from Phantom.)\n`
    );
  });
}

async function cmdUsage(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const out = await api<any>(cfg, "/usage?limit=20");
  return printJsonOrTable(args, out, (o) =>
    `total_calls:      ${o.total_calls}\n` +
    `total_cost_usd:   $${Number(o.total_cost_usd).toFixed(4)}\n` +
    `rate_per_call:    $${o.rate_usd_per_call}\n` +
    `\nrecent:\n` +
    o.items.slice(0, 10).map((i: any) =>
      `  ${i.created_at}  ${i.call_type.padEnd(14)}  $${Number(i.cost_usd).toFixed(4)}`,
    ).join("\n") + "\n",
  );
}

// `susu privacy` — toggle whether incoming friend adds auto-create a
// channel (`on`) or queue a request the user must accept (`off`).
// Default for new accounts is `off` (per migration 006). Args:
//   susu privacy            → show current setting + brief explanation
// ── Webhook ─────────────────────────────────────────────────────────────
async function cmdWebhook(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "set") {
    const url = args[1];
    if (!url || !url.startsWith("https://")) {
      process.stderr.write("usage: susu webhook set <https://url>\n");
      return 1;
    }
    const out = await api<any>(cfg, "/identity/webhook", {
      method: "POST", body: JSON.stringify({ url }),
    });
    return printJsonOrTable(args, out, (o) =>
      `webhook set: ${o.webhook_url}\n` +
      `secret:      ${o.webhook_secret}\n` +
      `\nAdd this secret to your webhook handler to verify X-Susu-Signature.\n`,
    );
  }

  if (sub === "get") {
    const out = await api<any>(cfg, "/identity/webhook");
    return printJsonOrTable(args, out, (o) =>
      o.webhook_url
        ? `url:    ${o.webhook_url}\nsecret: ${o.webhook_secret}\n`
        : "no webhook configured\n",
    );
  }

  if (sub === "clear" || sub === "remove" || sub === "delete") {
    const out = await api<any>(cfg, "/identity/webhook", { method: "DELETE" });
    return printJsonOrTable(args, out, () => "webhook cleared\n");
  }

  // No sub or unknown → show current
  if (!sub) {
    const out = await api<any>(cfg, "/identity/webhook");
    if (out.webhook_url) {
      process.stdout.write(
        `url:    ${out.webhook_url}\nsecret: ${out.webhook_secret}\n`,
      );
    } else {
      process.stdout.write(
        "no webhook configured\n\n" +
        "Set one to receive signals via HTTP POST (24/7 without local daemon):\n" +
        "  susu webhook set https://your-worker.example.com/webhook\n",
      );
    }
    return 0;
  }

  process.stderr.write("usage: susu webhook [set <url> | get | clear]\n");
  return 1;
}

//   susu privacy on         → flip to auto-accept (use only for trusted circles)
//   susu privacy off        → flip back to gate (default)
async function cmdPrivacy(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!cfg.token) { process.stderr.write("not logged in\n"); return 2; }
  const sub = (args[0] ?? "").toLowerCase();

  if (!sub) {
    // Show current
    const me = await api<any>(cfg, "/identity/whoami");
    const on = !!me.auto_accept_friends;
    process.stdout.write(
      `auto-accept friends: ${on ? "ON  (anyone can add you and immediately push)" : "OFF (incoming adds queue as requests; you accept manually)"}\n` +
      (on
        ? `\nflip OFF (recommended for most users):  susu privacy off\n`
        : `\nflip ON  (only if you trust everyone in your circle):  susu privacy on\n`),
    );
    return 0;
  }

  // `susu privacy gate on` / `susu privacy gate off` (preferred, unambiguous)
  if (sub === "gate") {
    const gateVal = (args[1] ?? "").toLowerCase();
    if (gateVal !== "on" && gateVal !== "off") {
      process.stderr.write("usage: susu privacy gate [on|off]\n  gate on  = require approval (safer, default)\n  gate off = auto-accept (trusted circles only)\n");
      return 1;
    }
    const value = gateVal === "off"; // gate OFF = auto-accept ON
    const out = await api<any>(cfg, "/identity/auto-accept", {
      method: "POST", body: JSON.stringify({ value }),
    });
    return printJsonOrTable(args, out, () =>
      `friend gate: ${gateVal.toUpperCase()} — ${value ? "auto-accept enabled" : "manual approval required"}\n`,
    );
  }

  // Legacy: `susu privacy on/off` (kept for compat, inverted naming)
  if (sub !== "on" && sub !== "off") {
    process.stderr.write("usage: susu privacy gate [on|off]\n  gate on  = require approval (safer, default)\n  gate off = auto-accept (trusted circles only)\n");
    return 1;
  }

  const value = sub === "on";
  const out = await api<any>(cfg, "/identity/auto-accept", {
    method: "POST", body: JSON.stringify({ value }),
  });
  return printJsonOrTable(args, out, () =>
    `auto-accept friends: ${value ? "ON" : "OFF"}\n`,
  );
}

async function cmdConfig(args: string[]): Promise<number> {
  const cfg = await loadConfig();
  // Default human view: just what the user actually controls (api_url,
  // their @handle, session state). The keypair is internal — visible only
  // via --json (which also redacts the private key).
  const safe = {
    ...cfg,
    secret_key_b58: cfg.secret_key_b58 ? "(redacted)" : undefined,
  };
  return printJsonOrTable(args, safe, (s: any) =>
    `api_url:  ${s.api_url}\n` +
    `handle:   ${s.handle ? "@" + s.handle : "(unregistered)"}\n` +
    `session:  ${s.token ? `active until ${s.token_expires_at}` : "(none — run `susu login`)"}\n` +
    `path:     ${CONFIG_PATH}\n`,
  );
}

async function cmdBook(args: string[]): Promise<number> {
  const path = await import("node:path");

  // Phase 17.5 — `susu book --queue` shows the paper close retry queue
  // (~/.susu/paper_close_queue.json). Use this to debug "why is the position
  // on server still showing open when I see closed locally" — entries in
  // queue mean daemon tried to sync close but server didn't ack yet.
  if (args.includes("--queue")) {
    const queuePath = path.join(configDir(), "paper_close_queue.json");
    let q: any;
    try {
      const raw = await (await import("node:fs/promises")).readFile(queuePath, "utf8");
      q = JSON.parse(raw);
    } catch {
      process.stdout.write("paper close queue: empty (no pending close-mirror calls)\n");
      return 0;
    }
    const entries = Array.isArray(q?.entries) ? q.entries : [];
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify({ depth: entries.length, entries }, null, 2) + "\n");
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("paper close queue: empty\n");
      return 0;
    }
    const isTTY = process.stdout.isTTY;
    const dim = (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
    const yellow = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
    const red = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
    const stale = entries.filter((e: any) => (e.attempts ?? 0) >= 5).length;
    process.stdout.write(`Paper Close Queue\n`);
    process.stdout.write(`  Pending: ${entries.length}  Stale (≥5 retries): ${stale > 0 ? red(String(stale)) : stale}\n\n`);
    for (const e of entries) {
      const sigShort = (e.payload?.signal_id ?? "").slice(0, 8);
      const ageMin = e.first_enqueued_at
        ? ((Date.now() - new Date(e.first_enqueued_at).getTime()) / 60_000).toFixed(1)
        : "?";
      const dueMs = e.next_attempt_at ? new Date(e.next_attempt_at).getTime() - Date.now() : 0;
      const dueLabel = dueMs <= 0 ? "now" : `in ${(dueMs / 1000).toFixed(0)}s`;
      const attemptStr = (e.attempts ?? 0) >= 5 ? red(`${e.attempts} attempts`) : yellow(`${e.attempts ?? 0} attempts`);
      process.stdout.write(
        `  ${sigShort}…  ${e.payload?.exit_reason ?? "?"}  ${attemptStr}  ` +
        `${dim(`enqueued ${ageMin}min ago, next try ${dueLabel}`)}\n`,
      );
      if (e.last_error) process.stdout.write(`    ${dim(`last error: ${e.last_error}`)}\n`);
    }
    return 0;
  }

  const tradesPath = path.join(configDir(), "paper_trades.json");
  let book: any;
  try {
    const raw = await (await import("node:fs/promises")).readFile(tradesPath, "utf8");
    book = JSON.parse(raw);
  } catch {
    process.stdout.write("no paper trades yet (daemon will create on first react +1)\n");
    return 0;
  }

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(book, null, 2) + "\n");
    return 0;
  }

  const trades = book.trades ?? [];
  const opens = trades.filter((t: any) => t.status === "open");
  const closed = trades.filter((t: any) => t.status === "closed");
  let balance = book.initial_balance ?? 100;
  for (const t of closed) if (t.pnl_usd != null) balance += t.pnl_usd;

  const isTTY = process.stdout.isTTY;
  const dim = (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
  const green = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
  const red = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
  const bold = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
  const pnlColor = (n: number) => n >= 0 ? green(`+${n.toFixed(2)}`) : red(n.toFixed(2));

  let statsLine = "";
  if (closed.length > 0) {
    const wins = closed.filter((t: any) => (t.pnl_pct ?? 0) > 0);
    const losses = closed.filter((t: any) => (t.pnl_pct ?? 0) <= 0);
    const winRate = ((wins.length / closed.length) * 100).toFixed(0);
    const avgWin = wins.length > 0 ? (wins.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / wins.length).toFixed(1) : "0";
    const avgLoss = losses.length > 0 ? (losses.reduce((s: number, t: any) => s + (t.pnl_pct ?? 0), 0) / losses.length).toFixed(1) : "0";
    statsLine = `Win: ${wins.length}/${closed.length} (${winRate}%)  Avg: +${avgWin}% / ${avgLoss}%\n`;
  }
  process.stdout.write(
    `${bold("Paper Trading Book")}\n` +
    `Balance: $${balance.toFixed(2)}  |  Open: ${opens.length}  |  Closed: ${closed.length}  |  Total: ${trades.length}\n` +
    (statsLine ? statsLine : "") + "\n",
  );

  if (opens.length > 0) {
    // Fetch live prices for open positions to show unrealized PnL.
    let prices = new Map<string, number>();
    try {
      const symbols = [...new Set(opens.map((t: any) => t.token))].join(",");
      const resp = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const data = await resp.json() as { symbol: string; price: string }[];
        const needed = new Set(opens.map((t: any) => t.token));
        for (const d of data) {
          if (needed.has(d.symbol)) prices.set(d.symbol, parseFloat(d.price));
        }
      }
    } catch { /* best effort — show positions without live PnL if fetch fails */ }

    process.stdout.write(`${bold("Open Positions")}\n`);
    for (const t of opens) {
      const age = ((Date.now() - new Date(t.opened_at).getTime()) / 3_600_000).toFixed(1);
      const livePrice = prices.get(t.token);
      let pnlStr = "";
      if (livePrice != null) {
        const pnlPct = ((livePrice - t.entry_price) / t.entry_price) * 100 * t.leverage;
        const pnlUsd = (pnlPct / 100) * t.position_usd;
        pnlStr = `  now=${livePrice}  pnl=${pnlColor(pnlPct)}% ($${pnlColor(pnlUsd)})`;
      }
      process.stdout.write(
        `  #${t.id} ${t.token.padEnd(12)} ${t.direction} ${t.leverage}x  ` +
        `entry=${t.entry_price}  SL=${t.stop_loss}  TP=${t.take_profit}` +
        `${pnlStr}  sf=${t.size_factor}  ${dim(`${age}h ago`)}  from ${t.peer}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (closed.length > 0) {
    process.stdout.write(`${bold("Recent Closes")} ${dim("(last 10)")}\n`);
    for (const t of closed.slice(-10)) {
      const pnl = t.pnl_pct ?? 0;
      const usd = t.pnl_usd ?? 0;
      process.stdout.write(
        `  #${t.id} ${t.token.padEnd(12)} ${(t.exit_reason ?? "?").padEnd(14)} ` +
        `pnl=${pnlColor(pnl)}%  ($${pnlColor(usd)})  ` +
        `best=${pnlColor(t.best_pnl_pct ?? 0)}%\n`,
      );
    }
  }

  return 0;
}

function printJsonOrTable<T>(args: string[], data: T, tablePrinter: (d: T) => string): number {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(tablePrinter(data));
  }
  return 0;
}
