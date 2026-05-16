// Phase 17 — Daemon state read endpoint for the redesigned web dashboard's
// "Agent state" panel. Reads the daemon config snapshot the daemon last
// reported via POST /identity/daemon-ping (see identity.ts).
//
// Fields may be null if:
//   - the daemon has never sent a config snapshot (old daemon, no patch)
//   - the daemon has never connected at all (no last_daemon_ping_at)
// Caller is expected to render "—" for null fields, not zero or placeholder.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";

export const daemonStateRoutes = new Hono();

// SSE feed-stream heartbeat writes last_daemon_ping_at every 60s
// (routes/signals.ts DAEMON_PING_INTERVAL). 90s gives one missed-write
// of margin before flipping to stale — keep these two numbers in lock-step:
// if you raise the SSE write interval, raise this threshold too.
const STALE_AFTER_SECONDS = 90;

function authError(c: any, e: any) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

daemonStateRoutes.get("/daemon/state", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); }
  catch (e) { return authError(c, e); }

  const rows = await sql<{
    last_daemon_ping_at: Date | null;
    last_daemon_version: string | null;
    daemon_provider: string | null;
    daemon_execution_mode: string | null;
    daemon_broker_connected: boolean | null;
    daemon_conv_threshold: number | null;
    daemon_min_size_factor: number | null;
    daemon_started_at: Date | null;
  }[]>`
    SELECT
      last_daemon_ping_at,
      last_daemon_version,
      daemon_provider,
      daemon_execution_mode,
      daemon_broker_connected,
      daemon_conv_threshold,
      daemon_min_size_factor,
      daemon_started_at
    FROM identities
    WHERE address = ${me}
    LIMIT 1
  `;
  const row = rows[0];

  if (!row) return c.json({ error: "identity_not_found" }, 404);

  const lastPingMs = row.last_daemon_ping_at ? row.last_daemon_ping_at.getTime() : null;
  const now = Date.now();
  const seconds_since_ping = lastPingMs ? Math.floor((now - lastPingMs) / 1000) : null;

  // Status derivation:
  //   never_seen → no ping ever
  //   online     → last ping within STALE_AFTER_SECONDS
  //   stale      → last ping older than that
  let status: "online" | "stale" | "never_seen";
  if (lastPingMs == null)                                 status = "never_seen";
  else if (seconds_since_ping! <= STALE_AFTER_SECONDS)    status = "online";
  else                                                    status = "stale";

  const uptime_seconds = row.daemon_started_at
    ? Math.max(0, Math.floor((now - row.daemon_started_at.getTime()) / 1000))
    : null;

  return c.json({
    status,
    last_ping_at: row.last_daemon_ping_at?.toISOString() ?? null,
    seconds_since_ping,
    version: row.last_daemon_version,
    provider: row.daemon_provider,
    execution_mode: row.daemon_execution_mode,           // 'paper' | 'live' | null
    broker_connected: row.daemon_broker_connected,
    conv_threshold: row.daemon_conv_threshold,
    min_size_factor: row.daemon_min_size_factor,
    started_at: row.daemon_started_at?.toISOString() ?? null,
    uptime_seconds,
  });
});
