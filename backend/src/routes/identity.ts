import { Hono } from "hono";
import { sql } from "../db.ts";
import {
  issueNonce, verifySignatureAndIssueSession, authedAddress, AuthError,
  issueStreamToken,
} from "../auth.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";
import { generateWebhookSecret } from "../lib/webhook.ts";

export const identityRoutes = new Hono();

// BETA-1.b: bot guard — same address can request a nonce 10x/min, same IP 30x/min.
// Tighter than business endpoints because /auth/nonce is the open registration door.
const NONCE_PER_ADDR = { windowMs: 60_000, max: 10 };
const NONCE_PER_IP = { windowMs: 60_000, max: 30 };
const REGISTER_PER_IP = { windowMs: 60_000, max: 5 };
const REGISTER_DAILY_PER_IP = 3;  // max registrations per IP per 24h (DB-backed, survives restart)
const VERIFY_PER_IP = { windowMs: 60_000, max: 10 };

function clientIp(c: any): string {
  // Trust Fly's edge-set header in prod; fall back to nothing in dev.
  return c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

identityRoutes.post("/auth/nonce", async (c) => {
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const address = String(body?.address ?? "");
  try {
    rateCheck(`nonce:addr:${address}`, NONCE_PER_ADDR);
    rateCheck(`nonce:ip:${clientIp(c)}`, NONCE_PER_IP);
    const out = await issueNonce(address);
    return c.json(out);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401 | 409);
    throw e;
  }
});

identityRoutes.post("/auth/verify", async (c) => {
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  try {
    rateCheck(`verify:ip:${clientIp(c)}`, VERIFY_PER_IP);
    const out = await verifySignatureAndIssueSession({
      address: String(body?.address ?? ""),
      nonce: String(body?.nonce ?? ""),
      signature_b58: String(body?.signature_b58 ?? ""),
      handle: body?.handle ? String(body.handle) : null,
    });
    return c.json(out);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401 | 409);
    throw e;
  }
});

// R2: clients that need SSE auth call this to mint a 5min single-use token.
// They pass it via ?stream_token=... — even if logged, it can't be replayed.
identityRoutes.post("/auth/stream-token", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    const out = await issueStreamToken(address);
    return c.json(out);
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

identityRoutes.get("/identity/whoami", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    const rows = await sql<{ address: string; username: string | null; auto_accept_friends: boolean; created_at: Date; last_mcp_ping_at: Date | null; last_daemon_ping_at: Date | null; last_daemon_version: string | null }[]>`
      SELECT address, username, auto_accept_friends, created_at, last_mcp_ping_at, last_daemon_ping_at, last_daemon_version
      FROM identities WHERE address = ${address}
    `;
    return c.json(rows[0] ?? { address, username: null });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

identityRoutes.post("/identity/ping", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));
    await sql`UPDATE identities SET last_mcp_ping_at = now() WHERE address = ${address}`;
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

// Phase 17 — Daemon ping carries a config snapshot so the web dashboard's
// Agent state panel can show provider / execution mode / broker / conv
// threshold / min size factor without SSHing into the daemon host.
//
// Semantics: daemon is the source of truth. When daemon SENDS a body, we
// overwrite every field present in the body — including null (= "daemon
// knows but value is unset / disabled"). Fields ABSENT from the body keep
// their prior value (so an old daemon that posts no body just updates the
// timestamp). This lets the dashboard reflect "paper trading disabled" as
// execution_mode=null → "—" instead of stale "paper" (G review #3).
identityRoutes.post("/identity/daemon-ping", async (c) => {
  try {
    const address = await authedAddress(c.req.header("authorization"));

    let body: any = null;
    try {
      const text = await c.req.text();
      if (text && text.length > 0) body = JSON.parse(text);
    } catch { /* ignore — treat as no body */ }

    // `has`: was the field present in the body at all?
    // `val`: parsed value (null if explicitly null or invalid).
    const has = (k: string) => body != null && Object.prototype.hasOwnProperty.call(body, k);

    const provider           = has("provider")           ? (body.provider != null ? String(body.provider).slice(0, 80) : null) : undefined;
    const exec_raw           = has("execution_mode")     ? (body.execution_mode != null ? String(body.execution_mode).toLowerCase() : null) : undefined;
    const execution_mode     = exec_raw === undefined ? undefined : (exec_raw === "paper" || exec_raw === "live" ? exec_raw : null);
    const broker_connected   = has("broker_connected")   ? (body.broker_connected != null ? Boolean(body.broker_connected) : null) : undefined;
    const conv_threshold     = has("conv_threshold")     ? (Number.isFinite(Number(body.conv_threshold)) ? Number(body.conv_threshold) : null) : undefined;
    const min_size_factor    = has("min_size_factor")    ? (Number.isFinite(Number(body.min_size_factor)) ? Number(body.min_size_factor) : null) : undefined;

    // Parse + validate timestamp instead of casting raw (G review #6).
    let daemon_started_at: string | null | undefined;
    if (!has("daemon_started_at")) {
      daemon_started_at = undefined;
    } else if (body.daemon_started_at == null) {
      daemon_started_at = null;
    } else {
      const parsed = new Date(String(body.daemon_started_at));
      daemon_started_at = isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    // Always bump last_daemon_ping_at. Optionally PATCH only the body-present
    // config fields (so a daemon posting no body just refreshes the ping
    // timestamp — preserves backwards compatibility).
    const patch: Record<string, any> = {};
    if (provider          !== undefined) patch.daemon_provider          = provider;
    if (execution_mode    !== undefined) patch.daemon_execution_mode    = execution_mode;
    if (broker_connected  !== undefined) patch.daemon_broker_connected  = broker_connected;
    if (conv_threshold    !== undefined) patch.daemon_conv_threshold    = conv_threshold;
    if (min_size_factor   !== undefined) patch.daemon_min_size_factor   = min_size_factor;
    if (daemon_started_at !== undefined) patch.daemon_started_at        = daemon_started_at;

    if (Object.keys(patch).length > 0) {
      await sql`UPDATE identities SET last_daemon_ping_at = now(), ${sql(patch)} WHERE address = ${address}`;
    } else {
      await sql`UPDATE identities SET last_daemon_ping_at = now() WHERE address = ${address}`;
    }
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
});

// D13: username is permanent, immutable.
// 2026-04-30 reserved-username policy:
//   - Self-serve registration requires 5-20 chars (3-4 char "rare" names
//     are blocked from self-serve; admin grants them on a whitelist basis).
//   - Reserved table further blocks system / obscenity / specifically-locked
//     rare names. Rare names with `granted_to = caller` pass through.
//   - Validation happens in this order so error messages are precise.
const USERNAME_RE_SELF_SERVE = /^[a-z0-9][a-z0-9_-]{4,19}$/;
const USERNAME_RE_DB_LIMIT = /^[a-z0-9][a-z0-9_-]{2,19}$/;  // hard floor — first char must be alnum to prevent CLI flag confusion (--flag)

identityRoutes.post("/identity/register", async (c) => {
  const ip = clientIp(c);
  try {
    rateCheck(`register:ip:${ip}`, REGISTER_PER_IP);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    throw e;
  }
  // DB-backed 24h per-IP cap (survives restarts, unlike in-memory rate limit).
  const [ipCount] = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM register_ips
    WHERE ip = ${ip} AND created_at > now() - interval '24 hours'
  `;
  if ((ipCount?.c ?? 0) >= REGISTER_DAILY_PER_IP) {
    return c.json({ error: "ip_register_limit", message: "too many registrations from this IP today", retry_after_sec: 3600 }, 429);
  }
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const raw = String(body?.username ?? "").trim().toLowerCase();
  // Strip leading @ if user types "@alice"
  const username = raw.startsWith("@") ? raw.slice(1) : raw;

  // Format check — reject anything outside the DB-level limit immediately.
  if (!USERNAME_RE_DB_LIMIT.test(username)) {
    recordEvent({ type: "register_failed", address: me, payload: { reason: "invalid_username", username } });
    return c.json({
      error: "invalid_username",
      message: "username must be 3-20 chars, lowercase a-z 0-9 _ -",
    }, 400);
  }

  // Already-registered users can't change. CHECK constraint at DB layer too.
  const existing = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${me}
  `;
  if (existing[0]?.username) {
    recordEvent({ type: "register_failed", address: me, payload: { reason: "already_locked" } });
    return c.json({ error: "username_already_locked", current: existing[0].username }, 409);
  }

  // Reserved-username gate. Three categories enforced:
  //   - system / obscenity → hard reject (never grantable)
  //   - rare → reject UNLESS this caller is the granted recipient
  // (See migration 005 + admin route `/admin/usernames` for management.)
  const reserved = await sql<{ category: string; reason: string | null; granted_to: string | null }[]>`
    SELECT category, reason, granted_to FROM reserved_usernames WHERE username = ${username}
  `;
  if (reserved[0]) {
    const r = reserved[0];
    const grantedToMe = r.granted_to === me;
    if (!grantedToMe || r.category !== "rare") {
      recordEvent({ type: "register_failed", address: me, payload: { reason: "reserved", username, category: r.category } });
      return c.json({
        error: "username_reserved",
        category: r.category,
        message: r.reason ?? "this name is reserved",
      }, 409);
    }
    // grantedToMe && rare → fall through to claim
  } else {
    // Not enumerated in reserved_usernames. Apply the self-serve length floor:
    // 3-4 char names are implicitly "rare" — only reachable via admin grant
    // (which writes to identities.username directly, bypassing this route).
    if (!USERNAME_RE_SELF_SERVE.test(username)) {
      recordEvent({ type: "register_failed", address: me, payload: { reason: "reserved", username, category: "rare" } });
      return c.json({
        error: "username_reserved",
        category: "rare",
        message: "names shorter than 5 characters are reserved; ask the operator to grant one",
      }, 409);
    }
  }

  // Atomic: claim username if it's not taken. UNIQUE constraint racing with
  // concurrent registrations is handled by 23505 → return 409 taken.
  try {
    await sql`
      UPDATE identities SET username = ${username} WHERE address = ${me}
    `;
  } catch (e: any) {
    if (e.code === "23505") {
      recordEvent({ type: "register_failed", address: me, payload: { reason: "taken", username } });
      return c.json({ error: "username_taken", username }, 409);
    }
    throw e;
  }

  recordEvent({ type: "register", address: me, payload: { username } });
  void sql`INSERT INTO register_ips(ip, address) VALUES (${ip}, ${me})`.catch(() => {});

  // v4: auto-add @demo as friend (server-side, not front-end button).
  // Fire-and-forget — inserts welcome+replay signals so the user's daemon
  // sees a complete eval→react loop on first SSE subscribe (via channel
  // history backfill). Failures don't block register response.
  void import("../lib/demo_setup.ts").then(({ ensureDemoFriend }) =>
    ensureDemoFriend(me, username),
  ).catch((err) => {
    console.error(`[register] ensureDemoFriend failed for ${me.slice(0, 8)}…:`, err?.message ?? err);
  });

  return c.json({ address: me, username });
});

// Resolve @username → address (used by friends/add and CLI for short-handle UX).
identityRoutes.get("/identity/by-username/:username", async (c) => {
  // No auth required — usernames are public discovery.
  const raw = c.req.param("username") ?? "";
  const username = raw.startsWith("@") ? raw.slice(1) : raw;
  // Lookup uses the wider {3,20} format — 3-4 char rare names that admin
  // granted are valid handles even though self-serve registration won't reach them.
  if (!USERNAME_RE_DB_LIMIT.test(username)) {
    return c.json({ error: "invalid_username" }, 400);
  }
  const rows = await sql<{ address: string; username: string }[]>`
    SELECT address, username FROM identities WHERE username = ${username}
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "username_not_found", username }, 404);
  return c.json(row);
});

// POST /identity/auto-accept  body: {value: boolean}
// Toggle the friend-add gate. Default for new identities is FALSE
// (migration 006). When false, anyone calling /friends/add against this
// user creates a pending friend_request the user (or their agent) must
// explicitly accept via /friends/accept. When true, friend adds become
// channel-creating immediately. Users in active dogfood circles where
// they trust everyone may flip to true; default conservative.
identityRoutes.post("/identity/auto-accept", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const value = Boolean(body?.value ?? body?.on);
  await sql`UPDATE identities SET auto_accept_friends = ${value} WHERE address = ${me}`;
  return c.json({ ok: true, auto_accept_friends: value });
});

// ── Webhook management ─────────────────────────────────────────────────
// POST /identity/webhook  body: {url: string}
// Set a webhook URL. Server POSTs signal/reaction events to this URL.
// Generates a shared secret for HMAC signature verification.
identityRoutes.post("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const url = body?.url;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return c.json({ error: "webhook_url must be an https:// URL" }, 400);
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(host) ||
      host === "[::1]"
    ) {
      return c.json({ error: "webhook_url must not point to a private/internal address" }, 400);
    }
  } catch {
    return c.json({ error: "webhook_url is not a valid URL" }, 400);
  }
  const secret = generateWebhookSecret();
  await sql`
    UPDATE identities SET webhook_url = ${url}, webhook_secret = ${secret}
    WHERE address = ${me}
  `;
  return c.json({ ok: true, webhook_url: url, webhook_secret: secret });
});

// GET /identity/webhook
identityRoutes.get("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  const rows = await sql<{ webhook_url: string | null; webhook_secret: string | null }[]>`
    SELECT webhook_url, webhook_secret FROM identities WHERE address = ${me}
  `;
  const row = rows[0];
  return c.json({
    webhook_url: row?.webhook_url ?? null,
    webhook_secret: row?.webhook_secret ?? null,
  });
});

// DELETE /identity/webhook
identityRoutes.delete("/identity/webhook", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  await sql`
    UPDATE identities SET webhook_url = NULL, webhook_secret = NULL
    WHERE address = ${me}
  `;
  return c.json({ ok: true });
});
