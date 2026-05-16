// Phase 17 — Local HTTP server for one-click daemon self-upgrade.
//
// Bound to 127.0.0.1:7777 only (loopback). Accepts:
//   GET  /healthz   no auth, returns {version, status}
//   POST /upgrade   Bearer auth, triggers npm install + spawn new daemon + exit
//
// THREAT MODEL (read before changing):
//
//  1. Cross-origin browser requests
//     Defense: CORS Access-Control-Allow-Origin = https://susurration.xyz only
//     (configurable via cfg.local_server.allowed_origins for dev).
//
//  2. CSRF via form POST (no preflight)
//     Defense: /upgrade requires `Authorization: Bearer` header → triggers
//     CORS preflight → browser blocks if origin disallowed. We do NOT
//     accept token via query string or form field.
//
//  3. DNS rebinding (attacker domain resolves to 127.0.0.1)
//     Defense: strict Host header check — must be 127.0.0.1:7777,
//     localhost:7777, or [::1]:7777. A rebound attacker site sends
//     Host: attacker.com which fails this check.
//
//  4. Token theft from disk
//     Out of scope here — the user's agent-config.json already holds the
//     same SUSU bearer token. If attacker can read that file, the daemon
//     is already fully compromised.
//
//  5. Restart-loop / install-bomb
//     Defense: 5-minute rate limit per upgrade attempt.
//
//  6. npm install -g requiring sudo
//     Detected via stderr scan + EACCES exit codes → returned as 500
//     with helpful error so web UI can fall back to copy-command path.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { openSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_VERSION } from "./susu_actions.ts";

export interface LocalServerConfig {
  /** Default 7777. If port is busy, the server logs and gives up — daemon
   *  continues running, just without one-click upgrade. */
  port?: number;
  /** CORS allowed origins. Default ["https://susurration.xyz"]. */
  allowed_origins?: string[];
  /** Disable entirely. Default false. */
  disabled?: boolean;
}

const DEFAULT_PORT = 7777;
const DEFAULT_ALLOWED_ORIGINS = ["https://susurration.xyz"];
const ALLOWED_HOSTS = new Set([
  "127.0.0.1", "localhost", "[::1]",
]);
const UPGRADE_RATE_LIMIT_MS = 5 * 60 * 1000;

// Caller-supplied bits — wired by daemon main().
export interface LocalServerDeps {
  /** SUSU bearer token from agent-config.json — used to authenticate
   *  /upgrade requests. Web dashboard has the same token; MCP adapter
   *  reads it from ~/.susu/config.json. */
  bearerToken: string;
  /** Absolute path to agent.config.json — spawned new daemon needs it. */
  configPath: string;
  /** Called when /upgrade succeeds and old daemon is about to exit.
   *  Used to abort the SSE stream and flush paper-trader state. */
  gracefulStop: (reason: string) => Promise<void> | void;
}

let lastUpgradeAt = 0;
let upgradeInFlight = false;

// Module-level handle so the upgrade flow can release the port + re-bind
// it on failure. Daemon code only ever runs one instance of startLocalServer.
let currentServer: HttpServer | null = null;
let currentPort = DEFAULT_PORT;
let currentAllowedOrigins: Set<string> = new Set(DEFAULT_ALLOWED_ORIGINS);
let currentDeps: LocalServerDeps | null = null;

/** Returns null if server failed to start (port busy etc) — daemon should
 *  continue without one-click upgrade. Returns the http.Server otherwise. */
export function startLocalServer(
  cfg: LocalServerConfig | undefined,
  deps: LocalServerDeps,
) {
  if (cfg?.disabled) {
    process.stderr.write("[daemon] local_server disabled in config\n");
    return null;
  }
  const port = cfg?.port ?? DEFAULT_PORT;
  const allowedOrigins = new Set(cfg?.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS);
  currentPort = port;
  currentAllowedOrigins = allowedOrigins;
  currentDeps = deps;

  const server = createServer((req, res) => {
    handleRequest(req, res, deps, allowedOrigins).catch((err) => {
      process.stderr.write(`[local_server] handler error: ${err}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[daemon] local_server: port ${port} busy — one-click upgrade disabled ` +
        `(MVP copy-command path still works)\n`,
      );
    } else {
      process.stderr.write(`[daemon] local_server error: ${err.message}\n`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[daemon] local_server listening on 127.0.0.1:${port}\n`);
  });

  currentServer = server;
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalServerDeps,
  allowedOrigins: Set<string>,
) {
  // ── DNS rebinding defense ──────────────────────────────────────────────
  // Host header must point to loopback. An attacker site rebound to
  // 127.0.0.1 still sends Host: attacker.com because that's what the
  // browser typed into the URL bar.
  const hostHeader = (req.headers.host ?? "").toLowerCase();
  const hostName = hostHeader.split(":")[0] ?? "";
  if (!ALLOWED_HOSTS.has(hostName) && !ALLOWED_HOSTS.has(hostHeader)) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "forbidden_host", host: hostHeader }));
    return;
  }

  // ── CORS preflight ─────────────────────────────────────────────────────
  const origin = (req.headers.origin ?? "") as string;
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      version: DAEMON_VERSION,
      upgrade_endpoint: "/upgrade",
    }));
    return;
  }

  if (req.method === "POST" && url === "/upgrade") {
    return handleUpgrade(req, res, deps);
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_found" }));
}

function constantTimeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function handleUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalServerDeps,
) {
  // ── Auth ───────────────────────────────────────────────────────────────
  const auth = (req.headers["authorization"] ?? "") as string;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized", reason: "missing_bearer" }));
    return;
  }
  if (!constantTimeStringEq(m[1]!, deps.bearerToken)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized", reason: "token_mismatch" }));
    return;
  }

  // ── Rate limit + in-flight guard ──────────────────────────────────────
  // Note: we set `lastUpgradeAt` AFTER npm install + spawn confirm to avoid
  // locking the user out for 5 min on a transient failure. The in-flight
  // lock alone serializes concurrent requests during the install window.
  const now = Date.now();
  if (upgradeInFlight) {
    res.statusCode = 409;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "upgrade_in_flight" }));
    return;
  }
  const elapsed = now - lastUpgradeAt;
  if (lastUpgradeAt > 0 && elapsed < UPGRADE_RATE_LIMIT_MS) {
    const retryAfter = Math.ceil((UPGRADE_RATE_LIMIT_MS - elapsed) / 1000);
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.setHeader("retry-after", String(retryAfter));
    res.end(JSON.stringify({ error: "rate_limited", retry_after_sec: retryAfter }));
    return;
  }

  upgradeInFlight = true;
  process.stderr.write(`[daemon] /upgrade requested — starting npm install\n`);

  // Fetch target version first so we can echo it back.
  let targetVersion: string | null = null;
  try {
    const r = await fetch("https://registry.npmjs.org/susurration-agent-daemon/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const data = await r.json() as { version?: string };
      targetVersion = data.version ?? null;
    }
  } catch { /* ok — npm install will tell us */ }

  if (targetVersion && targetVersion === DAEMON_VERSION) {
    upgradeInFlight = false;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      status: "already_latest",
      current: DAEMON_VERSION,
      latest: targetVersion,
    }));
    return;
  }

  // Run npm install -g.
  const install = spawnSync("npm", ["install", "-g", "susurration-agent-daemon@latest"], {
    encoding: "utf8",
    timeout: 120_000,
  });

  if (install.status !== 0) {
    upgradeInFlight = false;
    const stderr = (install.stderr ?? "").slice(0, 2000);
    const stdout = (install.stdout ?? "").slice(0, 500);
    const needsSudo = /EACCES|permission denied|EPERM/i.test(stderr);
    process.stderr.write(`[daemon] npm install failed (exit ${install.status}): ${stderr.slice(0, 400)}\n`);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "npm_install_failed",
      exit_code: install.status,
      needs_sudo: needsSudo,
      stderr: stderr,
      stdout: stdout,
      hint: needsSudo
        ? "Run `sudo npm install -g susurration-agent-daemon@latest` manually, then restart daemon."
        : "Check npm logs; you may need to fix npm permissions and retry.",
    }));
    return;
  }

  process.stderr.write(`[daemon] npm install -g succeeded — handing off to new daemon\n`);

  // Respond 200 before exiting so web sees success.
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    status: "upgrading",
    from: DAEMON_VERSION,
    to: targetVersion,
    note: "Old daemon will hand off to new daemon. Poll /healthz to see when new version is up. " +
          "Old daemon stays running if new daemon fails to come up (no daemon downtime).",
  }));

  // Drain response, then orchestrate the handoff.
  // Give the HTTP layer 500ms to flush before tearing down anything.
  setTimeout(async () => {
    await orchestrateHandoff(deps, targetVersion);
  }, 500);
}

/** Manages the dance of (1) releasing port 7777, (2) spawning new daemon,
 *  (3) polling new daemon's /healthz to confirm it's alive on the new version,
 *  (4) graceful exit if confirmed OR re-binding the port + recovering old
 *  daemon if not. */
async function orchestrateHandoff(
  deps: LocalServerDeps,
  targetVersion: string | null,
): Promise<void> {
  const port = currentPort;
  const oldServer = currentServer;

  // (1) Release port 7777 so the new daemon can bind it. We do this FIRST
  //     because both daemons cannot share the port and the new daemon will
  //     fail silently into "one-click disabled" mode if it can't bind.
  //
  //     `server.close()` only resolves when ALL connections drain — HTTP/1.1
  //     keep-alive from the upgrade request can hold it open until the
  //     browser closes the socket. We force-close idle keep-alive connections
  //     and race the close() against a 2s timeout so we never hang here.
  if (oldServer) {
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          oldServer.close(() => resolve());
          // Node 18.2+ — kicks idle keep-alive sockets so close() can drain.
          try { (oldServer as any).closeIdleConnections?.(); } catch {}
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      // Whether close() resolved or we timed out, the listening socket is
      // unbound after Node calls _handle.close internally on the listen socket.
      // If a connection is still holding the port via SO_REUSEADDR weirdness,
      // recoverOldDaemon will catch EADDRINUSE.
      currentServer = null;
      process.stderr.write(`[daemon] released port ${port} for new daemon\n`);
    } catch (err) {
      process.stderr.write(`[daemon] failed to close old http server: ${err}\n`);
    }
  }

  // (2) Spawn the new daemon. stderr redirected to ~/.susu/daemon-upgrade.log
  //     so post-mortem is possible if it fails to start.
  const susuDir = join(homedir(), ".susu");
  let logFd: number | null = null;
  try {
    mkdirSync(susuDir, { recursive: true });
    logFd = openSync(join(susuDir, "daemon-upgrade.log"), "a");
  } catch { /* fall back to ignore */ }

  // exit-handler MUST be attached BEFORE any other IO on the child, because
  // an immediate child failure (binary missing, EACCES, ESM loader error)
  // could emit 'exit' before we get to the listener-registration line.
  let childExitedEarly = false;
  let childExitCode: number | null = null;
  let child;
  try {
    child = spawn("susu-agent-daemon", ["--config", deps.configPath], {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    });
    child.on("exit", (code) => {
      childExitedEarly = true;
      childExitCode = code ?? null;
    });
    child.unref();
    process.stderr.write(`[daemon] spawned new daemon (pid=${child.pid}); stderr → ~/.susu/daemon-upgrade.log\n`);
  } catch (err) {
    process.stderr.write(`[daemon] FAILED to spawn new daemon: ${err}\n`);
    await recoverOldDaemon(deps, port);
    return;
  }

  // (3) Poll /healthz on the new daemon. Success = it reports a version
  //     >= targetVersion (or any version different from DAEMON_VERSION
  //     as a fallback if the target wasn't fetchable).
  const handoffDeadline = Date.now() + 8_000;
  let newVersionConfirmed: string | null = null;
  while (Date.now() < handoffDeadline) {
    if (childExitedEarly) {
      process.stderr.write(`[daemon] new daemon exited early (code=${childExitCode}); see ~/.susu/daemon-upgrade.log\n`);
      break;
    }
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (r.ok) {
        const data = await r.json() as { version?: string };
        if (data.version && data.version !== DAEMON_VERSION) {
          newVersionConfirmed = data.version;
          break;
        }
      }
    } catch { /* not up yet, keep polling */ }
  }

  if (!newVersionConfirmed) {
    process.stderr.write(`[daemon] new daemon did not confirm healthy in 8s — rolling back.\n`);
    // Best-effort kill of the zombie / mis-bound new process so it doesn't
    // try to retake the port we're about to re-bind.
    try { child.kill("SIGTERM"); } catch {}
    await sleep(500);
    await recoverOldDaemon(deps, port);
    return;
  }

  process.stderr.write(`[daemon] new daemon healthy on v${newVersionConfirmed} — old daemon exiting.\n`);
  lastUpgradeAt = Date.now();  // only mark rate-limit window on actual success
  try {
    await deps.gracefulStop("UPGRADE");
  } catch (err) {
    process.stderr.write(`[daemon] gracefulStop during upgrade failed: ${err}\n`);
  }
  setTimeout(() => process.exit(0), 500);
}

/** Called when handoff fails: kill the new daemon if it's still hanging
 *  around, re-bind the local server so the user retains one-click upgrade,
 *  and clear the in-flight lock so the user can retry. */
async function recoverOldDaemon(deps: LocalServerDeps, port: number): Promise<void> {
  upgradeInFlight = false;
  try {
    // Re-create the http server on the same port — daemon stays alive.
    const server = createServer((req, res) => {
      handleRequest(req, res, deps, currentAllowedOrigins).catch((err) => {
        process.stderr.write(`[local_server] handler error: ${err}\n`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(`[daemon] recovery: port ${port} still busy — one-click disabled until daemon restart\n`);
      } else {
        process.stderr.write(`[daemon] recovery local_server error: ${err.message}\n`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onListen = () => { server.removeListener("error", onError); resolve(); };
      const onError = (e: Error) => { server.removeListener("listening", onListen); reject(e); };
      server.once("listening", onListen);
      server.once("error", onError);
      server.listen(port, "127.0.0.1");
    });
    currentServer = server;
    process.stderr.write(`[daemon] recovery: re-bound port ${port}; old daemon continues running. User may retry upgrade.\n`);
  } catch (err) {
    process.stderr.write(`[daemon] recovery FAILED to re-bind port: ${err}\n`);
    process.stderr.write(`[daemon] one-click upgrade is broken until daemon restart, but daemon itself continues running.\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
