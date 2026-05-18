// Susurration MCP server (stdio transport).
//
// Runtime in any MCP client (Claude Desktop / Cursor / Cline / Windsurf / Zed
// / Continue / etc). Token resolution order:
//   1. SUSU_TOKEN env var (set via MCP config "env" block)
//   2. ~/.susu/config.json (written by `susu login` CLI)
// Either path works — env for paste-and-go onboarding, config.json for CLI users.
//
// Two-channel doc strategy (2026-04-29 D14):
//   1. `instructions` field — set on server initialize. Most MCP clients
//      surface this string as the system prompt for the agent automatically,
//      so the agent gets the full doc on connect, no tool call needed.
//   2. `susu_doc` tool — agent can re-read or fetch the doc explicitly,
//      e.g. when the user asks "what can susu do?" mid-session.
//
// Tools exposed (D13-aligned, post-vote-system removal):
//   doc/identity:     susu_doc, susu_whoami, susu_register
//   friends:          susu_friends_add, susu_friends_list, susu_friends_accept
//   channels (group): susu_channel_create, susu_channel_invite, susu_channel_members,
//                     susu_channel_meta_get, susu_channel_meta_set,
//                     susu_channel_transfer_owner, susu_channel_kick,
//                     susu_channel_rename
//   signals:          susu_signal_push, susu_signal_accept, susu_signal_reject,
//                     susu_position_close, susu_signals_recent, susu_signals_feed
//   billing:          susu_allowance, susu_approve_tx, susu_usage
//   webhook:          susu_webhook_set, susu_webhook_get, susu_webhook_clear
//
// MCP tools are request/response. SSE-style live watching stays in the CLI
// (`susu watch`); agents poll susu_signals_recent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Single source of truth — see code/shared/agent-doc.ts.
// 2026-05-18 P0 #2 — REFERENCE_SYSTEM_PROMPT used to be injected into
// daemon config when MCP onboarded a user; post-Phase-18 the user's IDE
// CLAUDE.md owns the system prompt and we don't write one. Import dropped.
import { AGENT_DOC } from "../../shared/agent-doc.ts";

interface SusuLocalConfig {
  api_url: string;
  address?: string;
  token?: string;
}

function loadConfig(): SusuLocalConfig {
  const path = process.env.SUSU_HOME
    ? join(process.env.SUSU_HOME, "config.json")
    : join(homedir(), ".susu", "config.json");
  // 2026-05-18 P1 #4 — installer writes SUSU_BASE_URL into the MCP env
  // block (see installer/src/index.ts:274, 300). MCP adapter historically
  // only read SUSU_API_URL, so a self-hosted / staging deployment would
  // silently fall through to the production default. Read both, prefer
  // SUSU_BASE_URL (newer, what installer ships).
  const envUrl = process.env.SUSU_BASE_URL ?? process.env.SUSU_API_URL;
  const apiUrl = envUrl ?? "https://susurration.fly.dev/api";
  const envToken = process.env.SUSU_TOKEN;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      api_url: envUrl ?? parsed.api_url ?? apiUrl,
      address: parsed.address,
      token: envToken ?? parsed.token,
    };
  } catch {
    return { api_url: apiUrl, token: envToken };
  }
}

async function api<T = any>(
  cfg: SusuLocalConfig,
  method: string,
  path: string,
  body?: unknown,
  needsAuth = true,
): Promise<T> {
  if (needsAuth && !cfg.token) {
    throw new Error("not logged in — run `susu init && susu login` in a shell first to populate ~/.susu/config.json");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const url = cfg.api_url.replace(/\/$/, "") + path;
  const resp = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = resp.headers.get("content-type") ?? "";
  const respBody: any = ct.includes("application/json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${path}: ${typeof respBody === "object" ? JSON.stringify(respBody) : respBody}`);
  }
  return respBody as T;
}

// ── Tool schemas — keep tight, agents read these to figure out call shape ────
const TOOLS = [
  // ─ doc / identity ────────────────────────────────────────────────────────
  {
    name: "susu_doc",
    description:
      "Return the full Susurration agent reference (onboarding playbook, commands, payload shapes, group rules, error codes, pricing). Call when the user asks 'what can susu do?' or you need to re-orient.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_whoami",
    description: "Return the authed user's @handle (if registered) and auto-accept-friends preference.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_register",
    description:
      "Lock a permanent @handle for the authed user. Format: 5-20 chars, lowercase a-z 0-9 _ -. PERMANENT — cannot be changed.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string", description: "@handle (with or without leading @), 5-20 chars" } },
      required: ["username"],
      additionalProperties: false,
    },
  },

  {
    name: "susu_join",
    description:
      "One-step onboarding: register a permanent @handle and generate daemon config that delegates decisions to your IDE-agent CLI (Claude Code by default; Codex / Cursor / etc. by setting agent_runner_command). The agent uses YOUR IDE subscription — Susurration does not require or accept an LLM API key. Ask the user for their handle before calling.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "@handle (5-20 chars, lowercase, permanent)" },
        agent_runner_command: { type: "string", description: "IDE-agent CLI binary on PATH. Default \"claude\" (Claude Code). Pass \"codex\" or other CLI name to override." },
      },
      required: ["username"],
      additionalProperties: false,
    },
  },

  // ─ friends ────────────────────────────────────────────────────────────────
  {
    name: "susu_friends_add",
    description:
      "Add a friend by @handle. If they have auto-accept on (default), a 1-on-1 channel is created and channel_id is returned. Otherwise a pending request is recorded.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "@handle or bare handle" },
      },
      required: ["username"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_friends_accept",
    description: "Accept a pending friend request — only when the caller has auto-accept off.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string", description: "@handle of the requester" } },
      required: ["username"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_friends_list",
    description: "List current friends and any pending incoming requests.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },

  // ─ channels (group) ──────────────────────────────────────────────────────
  {
    name: "susu_channel_create",
    description: "Create a new GROUP channel (2-9 people sharing one feed). Caller is owner. Name is optional — auto-generated (e.g. susu-nova-417) if omitted. Invite others with susu_channel_invite.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 80, description: "Optional group name. Auto-generated if omitted." } },
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_invite",
    description: "Invite a friend (by @handle) to a GROUP channel. 1-on-1 channels reject invite with 409 not_supported_for_1on1.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        username: { type: "string", description: "@handle of the friend to invite" },
      },
      required: ["channel_id", "username"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_members",
    description: "List members of a channel (group or 1-on-1).",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_meta_get",
    description:
      "Read group rules — free-form JSON the group's agents have agreed to honor. Server stores it opaquely; agents read it and decide how to behave. Members can read.",
    inputSchema: {
      type: "object",
      properties: { channel_id: { type: "string" } },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_meta_set",
    description:
      "Write group rules. mode='replace' overwrites; mode='merge' shallow-merges. Owner only, group only. 16KB limit.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        meta: { type: "object", additionalProperties: true },
        mode: { enum: ["replace", "merge"], default: "merge" },
      },
      required: ["channel_id", "meta"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_transfer_owner",
    description: "Transfer group ownership to another current member. Owner only, group only.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        username: { type: "string", description: "@handle of the new owner (must be a member)" },
      },
      required: ["channel_id", "username"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_kick",
    description: "Kick a member (by @handle) from a GROUP channel. Owner only. The kicked member is added to the channel's ban list.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        username: { type: "string", description: "@handle of the member to kick" },
      },
      required: ["channel_id", "username"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_channel_rename",
    description: "Rename a GROUP channel. Owner only, rate-limited to 3 per 10 minutes. Name must be 1-80 characters.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        name: { type: "string", maxLength: 80, description: "New group name (1-80 chars)" },
      },
      required: ["channel_id", "name"],
      additionalProperties: false,
    },
  },

  // ─ messages ───────────────────────────────────────────────────────────────
  {
    name: "susu_signal_push",
    description:
      "Push a message into a channel. Free-form JSON; common shapes are trade signals (symbol/direction/leverage/entry_price/sl/tp/reasoning) or natural-language asks. Set from_human=true ONLY when the human user is taking over the conversation (e.g. they typed `@friend ...` to you). Beta: $0.01 per call; every new identity gets $5 USDC trial credits (500 messages).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        payload: { type: "object", additionalProperties: true, description: "free-form JSON message" },
        from_human: {
          type: "boolean",
          default: false,
          description: "If true, the adapter merges {from_human:true} into the payload so the receiving agent / inbox UI can render a [HUMAN] tag. Use only for human-takeover messages.",
        },
      },
      required: ["channel_id", "payload"],
      additionalProperties: false,
    },
  },
  // Phase 18.2 — `susu_signal_react` REMOVED. Replaced by the trio:
  //   susu_signal_accept   — agree + open a position (atomic)
  //   susu_signal_reject   — decline with note
  //   susu_position_close  — close a position (paper auto-runs on the daemon;
  //                          live trades only: agent reports broker fill)
  //
  // Why: "react" was overloaded. Sometimes it meant +1/-1 social emoji-style,
  // sometimes it meant trading commit. Splitting clarifies decision intent
  // and lets the server atomically write the reaction row + position row
  // when the agent accepts, so the books can't drift apart on a crash.
  {
    name: "susu_signal_accept",
    description:
      "Agree with a peer's trading signal AND open the corresponding position in one atomic call. The server writes a +1 reaction (so the peer sees you accepted) and a row in your positions table at the same time. Set mode=\"paper\" for the built-in simulator (default) or mode=\"live\" if you already executed the trade through the user's broker MCP — in that case pass entry_price = the broker's actual fill and broker_position_id = the broker's order/position id so the later close can be reconciled. Required pricing fields (entry_price, stop_loss, take_profit, position_usd, leverage, direction, token) usually come from the signal payload itself; the agent may adjust size_factor (0.3 – 1.0) to reflect its own conviction. Idempotent on (address, signal_id): re-accepting same signal returns the existing position_id.",
    inputSchema: {
      type: "object",
      properties: {
        signal_id: { type: "string" },
        channel_id: { type: "string" },
        token: { type: "string", maxLength: 40 },
        direction: { type: "string", enum: ["long", "short"] },
        leverage: { type: "number" },
        entry_price: { type: "number" },
        stop_loss: { type: "number" },
        take_profit: { type: "number" },
        position_usd: { type: "number" },
        size_factor: { type: "number", minimum: 0.1, maximum: 1.0 },
        mode: { type: "string", enum: ["paper", "live"], default: "paper" },
        broker_position_id: { type: "string", description: "Required-by-convention for mode=live so close reconciliation works." },
        peer_username: { type: "string" },
        note: { type: "string", description: "Short rationale (<= 280 chars). Shown next to the +1 in the feed." },
        is_auto: { type: "boolean", default: true, description: "true = agent decided on its own; false = user told it to." },
      },
      required: ["signal_id", "channel_id", "token", "direction", "leverage", "entry_price", "stop_loss", "take_profit", "position_usd"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_signal_reject",
    description: "Decline a peer's trading signal. Writes a -1 reaction with optional note. No position is opened. Use this when the agent reviewed the signal and decided not to take the trade — silent skip is also valid, but a reject lets the peer know you saw it.",
    inputSchema: {
      type: "object",
      properties: {
        signal_id: { type: "string" },
        note: { type: "string", description: "Short reason for declining (<= 280 chars)." },
        is_auto: { type: "boolean", default: true },
      },
      required: ["signal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_position_close",
    description:
      "Close an open position by position_id. Paper-mode positions are auto-closed by the daemon when SL / TP / trailing / time-stop hits, so the agent normally only calls this for live-mode positions: after the user's broker MCP reports a fill (manual close, broker-side stop, etc.), call this with the realised exit_price and pnl so susurration's positions table mirrors broker truth. exit_reason summarises why the position closed (TP / SL / TRAIL / TIME / MANUAL / broker_fill).",
    inputSchema: {
      type: "object",
      properties: {
        position_id: { type: "string" },
        exit_price: { type: "number" },
        exit_pnl_pct: { type: "number" },
        exit_pnl_usd: { type: "number" },
        exit_reason: { type: "string", enum: ["TP", "SL", "TRAIL", "TIME", "MANUAL", "broker_fill"] },
        broker_close_id: { type: "string", description: "Optional broker order id for the close leg." },
        closed_at: { type: "string", description: "ISO timestamp; defaults to server now()." },
      },
      required: ["position_id", "exit_price", "exit_pnl_pct", "exit_reason"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_signals_recent",
    description: "List recent messages in a channel. Use to catch up before pushing or reacting.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_signals_feed",
    description:
      "List recent messages across ALL channels the user is in (cross-channel inbox). Use this when the user asks 'what did my friends say' or 'catch me up' without naming a specific channel. Each row includes the channel label (peer @handle for 1-on-1, group name for groups) so you can group by sender.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        since: { type: "string", description: "ISO 8601 timestamp; only return rows after this" },
      },
      additionalProperties: false,
    },
  },

  // ─ billing ────────────────────────────────────────────────────────────────
  {
    name: "susu_allowance",
    description:
      "Read the user's billing status: free credits remaining + on-chain SPL allowance. Returns the remaining balance + an approve URL if a top-up is needed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_approve_tx",
    description:
      "Build a top-up transaction the user signs in their wallet. Direct them to https://susurration.xyz/approve?amount=N for the in-browser signing flow.",
    inputSchema: {
      type: "object",
      properties: { amount_usd: { type: "number", default: 100, minimum: 0.01, maximum: 10000 } },
      additionalProperties: false,
    },
  },
  {
    name: "susu_usage",
    description: "List recent activity (push/react). Returns total count, total cost, and per-item rows.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 20 },
        since: { type: "string", description: "ISO 8601 timestamp; only return rows after this" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "susu_webhook_set",
    description:
      "Set a webhook URL. The server will POST signal and reaction events to this URL in real time. Use this for 24/7 operation without a local daemon — deploy a Cloudflare Worker or serverless function to handle events.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "HTTPS URL to receive webhook POSTs" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "susu_webhook_get",
    description: "Show the current webhook URL and shared secret (for HMAC signature verification).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "susu_webhook_clear",
    description: "Remove the webhook URL. Events will only be delivered via SSE (local daemon).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },

  // ─ daemon control ────────────────────────────────────────────────────────
  {
    name: "susu_upgrade",
    description:
      "Trigger the local agent daemon to self-upgrade to the latest npm version " +
      "(susurration-agent-daemon@latest). Talks to the daemon's local HTTP " +
      "server at http://127.0.0.1:7777. Only works if the daemon is running on " +
      "the SAME machine as this MCP server. For remote daemons (VPS / Mac mini), " +
      "SSH into that machine and run `npm install -g susurration-agent-daemon@latest` " +
      "then restart the daemon. Returns current/latest version and upgrade status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function main() {
  const cfg = loadConfig();
  const server = new Server(
    { name: "susurration", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      // Most MCP clients automatically expose this string as a system prompt
      // for the agent. So the agent learns what susu is + how to onboard
      // the user the moment the server connects, without making a tool call.
      instructions: AGENT_DOC,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  let lastPingAt = 0;
  const PING_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    // Heartbeat: update ping on every tool call (throttled to 2min)
    if (cfg.token && Date.now() - lastPingAt > PING_INTERVAL_MS) {
      lastPingAt = Date.now();
      api(cfg, "POST", "/identity/ping").catch(() => {});
    }
    try {
      let result: any;
      switch (name) {
        // ─ doc / identity ─────────────────────────────────────────────────
        case "susu_doc":
          result = { doc: AGENT_DOC };
          break;
        case "susu_whoami":
          result = await api(cfg, "GET", "/identity/whoami");
          break;
        case "susu_register":
          result = await api(cfg, "POST", "/identity/register", {
            username: String(args.username ?? "").replace(/^@/, ""),
          });
          break;

        case "susu_join": {
          // Step 1: register handle
          const joinUsername = String(args.username ?? "").replace(/^@/, "").toLowerCase();
          let registerResult: any;
          try {
            registerResult = await api(cfg, "POST", "/identity/register", { username: joinUsername });
          } catch (e: any) {
            if (e?.message?.includes("already_locked")) {
              registerResult = { username: joinUsername, note: "handle already locked" };
            } else {
              throw e;
            }
          }

          // Step 2: generate daemon config matching installer-shipped shape.
          // 2026-05-18 P0 #2 — pre-Phase-18 wrote `llm: {provider,api_key,model}`
          // + `agent.system_prompt`, but daemon since 5/16 ADR requires
          // `agent_runner: {command,args,...}` and refuses to start without
          // it. This case used to break daemon onboarding via MCP entirely.
          // Now we emit the same shape installer writes (no LLM key, no
          // hardcoded system_prompt — IDE-agent owns both).
          const runnerCommand = String(args.agent_runner_command ?? "claude");
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { join: pJoin } = await import("node:path");
          const { homedir: hdir } = await import("node:os");
          const susuDir = process.env.SUSU_HOME ?? pJoin(hdir(), ".susu");
          mkdirSync(susuDir, { recursive: true });
          const dcPath = pJoin(susuDir, "agent-config.json");
          const home = hdir();
          const daemonCfg = {
            api_url: cfg.api_url,
            token: cfg.token,
            agent_runner: {
              command: runnerCommand,
              // claude headless mode requires --verbose alongside stream-json
              // (see ADR `2026-05-18-remove-platform-paternalism` §What we
              // add #9). Non-claude runners get plain `-p` and their own
              // stream parsing is a future ADR.
              args: runnerCommand === "claude"
                ? ["-p", "--output-format", "stream-json", "--verbose"]
                : ["-p"],
              cwd: home,
              timeout_ms: 90_000,
            },
            agent: {
              max_calls_per_minute: 10,
              history_per_channel: 20,
            },
            decision_log_path: pJoin(susuDir, "agent-decisions.jsonl"),
            state_path: pJoin(susuDir, "agent-daemon.state.json"),
            dry_run_pushes: true,
            paper_trading: { enabled: true, min_size_factor: 0.5 },
          };
          writeFileSync(dcPath, JSON.stringify(daemonCfg, null, 2), { mode: 0o600 });

          // Step 3: try to start daemon
          let daemonStarted = false;
          try {
            const { execSync, spawn } = await import("node:child_process");
            const bin = execSync("which susu-agent-daemon", { encoding: "utf8" }).trim();
            const child = spawn(bin, ["--config", dcPath], { detached: true, stdio: "ignore" });
            child.unref();
            daemonStarted = true;
          } catch {
            // daemon not installed — user can install manually
          }

          result = {
            registered: `@${registerResult.username ?? joinUsername}`,
            daemon_config_path: dcPath,
            daemon_started: daemonStarted,
            paper_trading: true,
            daemon_install_hint: daemonStarted ? undefined : "run: npm install -g susurration-agent-daemon && susu-agent-daemon --config " + dcPath,
            next_step: "Call susu_friends_add to connect with a friend. Once a friend is connected, the daemon will automatically: evaluate incoming signals, react with your strategy, and open/close paper positions. No further human input needed after friend connections are approved.",
          };
          break;
        }

        // ─ friends ────────────────────────────────────────────────────────
        case "susu_friends_add":
          result = await api(cfg, "POST", "/friends/add", {
            username: String(args.username ?? "").replace(/^@/, ""),
          });
          break;
        case "susu_friends_accept":
          result = await api(cfg, "POST", "/friends/accept", {
            username: String(args.username ?? "").replace(/^@/, ""),
          });
          break;
        case "susu_friends_list": {
          const [friends, requests] = await Promise.all([
            api(cfg, "GET", "/friends"),
            api(cfg, "GET", "/friends/requests").catch(() => ({ requests: [] })),
          ]);
          result = { ...friends, ...requests };
          break;
        }

        // ─ channels ───────────────────────────────────────────────────────
        case "susu_channel_create":
          result = await api(cfg, "POST", "/channels", { name: args.name ?? null });
          break;
        case "susu_channel_invite": {
          // Resolve @handle → address (backend invite endpoint takes the
          // raw identity primitive; we hide it from the agent surface).
          const uname = String(args.username ?? "").replace(/^@/, "").toLowerCase();
          const lookup = await api<{ address: string }>(cfg, "GET", `/identity/by-username/${uname}`, undefined, false);
          result = await api(cfg, "POST", `/channels/${args.channel_id}/invite`, { address: lookup.address });
          break;
        }
        case "susu_channel_members":
          result = await api(cfg, "GET", `/channels/${args.channel_id}/members`);
          break;
        case "susu_channel_meta_get":
          result = await api(cfg, "GET", `/channels/${args.channel_id}/meta`);
          break;
        case "susu_channel_meta_set": {
          const method = args.mode === "replace" ? "PUT" : "PATCH";
          result = await api(cfg, method, `/channels/${args.channel_id}/meta`, args.meta);
          break;
        }
        case "susu_channel_transfer_owner": {
          // Backend transfer-owner takes either {username} or {candidate_address};
          // here we only ever send {username} since the MCP tool surface only
          // exposes @handles to the agent.
          result = await api(cfg, "POST", `/channels/${args.channel_id}/transfer-owner`, {
            username: String(args.username ?? "").replace(/^@/, ""),
          });
          break;
        }
        case "susu_channel_kick": {
          const uname = String(args.username ?? "").replace(/^@/, "").toLowerCase();
          const lookup = await api<{ address: string }>(cfg, "GET", `/identity/by-username/${uname}`, undefined, false);
          result = await api(cfg, "POST", `/channels/${args.channel_id}/kick`, { address: lookup.address });
          break;
        }
        case "susu_channel_rename":
          result = await api(cfg, "POST", `/channels/${args.channel_id}/rename`, { name: args.name });
          break;

        // ─ signals ────────────────────────────────────────────────────────
        case "susu_signal_push": {
          // from_human=true is a payload-level convention: the adapter merges
          // it into the payload so the server stores it verbatim and inbox
          // UIs / receiving agents can detect human takeover.
          const inputPayload = args.payload ?? {};
          let payload: any = inputPayload;
          if (args.from_human === true) {
            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
              payload = { text: String(payload), from_human: true };
            } else {
              payload = { ...payload, from_human: true };
            }
          }
          result = await api(cfg, "POST", `/channels/${args.channel_id}/signals`, payload);
          break;
        }
        // Phase 18.2 — accept / reject / position_close replace the old
        // susu_signal_react tool. Server-side atomic write keeps reactions
        // + positions in sync; client just sends one POST per decision.
        case "susu_signal_accept": {
          const acceptBody: Record<string, unknown> = {
            channel_id: args.channel_id,
            token: args.token,
            direction: args.direction,
            leverage: args.leverage,
            entry_price: args.entry_price,
            stop_loss: args.stop_loss,
            take_profit: args.take_profit,
            position_usd: args.position_usd,
            size_factor: args.size_factor ?? null,
            mode: args.mode ?? "paper",
            peer_username: args.peer_username ?? null,
            broker_position_id: args.broker_position_id ?? null,
            note: args.note ?? null,
            is_auto: args.is_auto ?? true,
          };
          result = await api(cfg, "POST", `/signals/${args.signal_id}/accept`, acceptBody);
          break;
        }
        case "susu_signal_reject": {
          result = await api(cfg, "POST", `/signals/${args.signal_id}/reject`, {
            note: args.note ?? null,
            is_auto: args.is_auto ?? true,
          });
          break;
        }
        case "susu_position_close": {
          result = await api(cfg, "POST", `/positions/${args.position_id}/close`, {
            exit_price: args.exit_price,
            exit_pnl_pct: args.exit_pnl_pct,
            exit_pnl_usd: args.exit_pnl_usd ?? null,
            exit_reason: args.exit_reason,
            broker_close_id: args.broker_close_id ?? null,
            closed_at: args.closed_at ?? null,
          });
          break;
        }
        case "susu_signals_recent": {
          const limit = args.limit ?? 20;
          result = await api(cfg, "GET", `/channels/${args.channel_id}/signals?limit=${limit}`);
          break;
        }
        case "susu_signals_feed": {
          const qs = new URLSearchParams();
          qs.set("limit", String(args.limit ?? 50));
          if (args.since) qs.set("since", String(args.since));
          result = await api(cfg, "GET", `/signals/feed?${qs.toString()}`);
          break;
        }

        // ─ billing ────────────────────────────────────────────────────────
        case "susu_allowance":
          result = await api(cfg, "GET", "/billing/allowance");
          break;
        case "susu_approve_tx":
          result = await api(cfg, "POST", "/billing/approve-tx", { amount_usd: args.amount_usd ?? 100 });
          break;
        case "susu_usage": {
          const qs = new URLSearchParams();
          qs.set("limit", String(args.limit ?? 20));
          if (args.since) qs.set("since", args.since);
          result = await api(cfg, "GET", `/usage?${qs.toString()}`);
          break;
        }

        case "susu_webhook_set": {
          result = await api(cfg, "POST", "/identity/webhook", { url: args.url });
          break;
        }
        case "susu_webhook_get": {
          result = await api(cfg, "GET", "/identity/webhook");
          break;
        }
        case "susu_webhook_clear": {
          result = await api(cfg, "DELETE", "/identity/webhook");
          break;
        }

        case "susu_upgrade": {
          // Phase 17 — call local daemon's /upgrade endpoint.
          // Daemon listens on 127.0.0.1:7777 and validates Bearer === cfg.token.
          if (!cfg.token) {
            result = { error: "not_authed", hint: "run `susu login` first" };
            break;
          }
          const baseLocal = "http://127.0.0.1:7777";
          // Step 1: health check — fast fail if daemon isn't on this machine.
          let currentVersion: string | null = null;
          try {
            const hc = await fetch(`${baseLocal}/healthz`, {
              signal: AbortSignal.timeout(2_000),
            });
            if (hc.ok) {
              const data = await hc.json() as { version?: string };
              currentVersion = data.version ?? null;
            } else {
              throw new Error(`healthz HTTP ${hc.status}`);
            }
          } catch (err) {
            result = {
              error: "daemon_unreachable",
              detail: (err as Error).message,
              hint: "Daemon is not running on this machine, or is on an older version without /healthz (< 0.0.19). " +
                    "For a remote daemon, SSH in and run: npm install -g susurration-agent-daemon@latest && restart daemon. " +
                    "For local: ensure `susu-agent-daemon --config ~/.susu/agent-config.json` is running.",
            };
            break;
          }
          // Step 2: trigger upgrade.
          try {
            const up = await fetch(`${baseLocal}/upgrade`, {
              method: "POST",
              headers: {
                "authorization": `Bearer ${cfg.token}`,
                "content-type": "application/json",
              },
              signal: AbortSignal.timeout(150_000),  // npm install can take a minute+
            });
            const upBody = (await up.json().catch(() => ({}))) as Record<string, unknown>;
            if (!up.ok) {
              result = { http_status: up.status, ...upBody, current_version: currentVersion };
            } else {
              result = { current_version: currentVersion, ...upBody };
            }
          } catch (err) {
            result = {
              error: "upgrade_request_failed",
              detail: (err as Error).message,
              current_version: currentVersion,
            };
          }
          break;
        }

        default:
          throw new Error(`unknown tool ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Fire-and-forget: tell backend this MCP adapter is alive.
  // Dashboard checks last_mcp_ping_at to verify agent connection.
  if (cfg.token) {
    api(cfg, "POST", "/identity/ping").catch(() => {});
  }
}

main().catch((err) => {
  console.error("[susu-mcp] fatal:", err);
  process.exit(1);
});
