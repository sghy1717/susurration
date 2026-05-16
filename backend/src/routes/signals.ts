// Signal + Reaction routes.
//
// D4: protocol does not validate payload shape — accept any JSON.
// D5: every push (signal or reaction) writes one usage_log row (atomic).
// D3: no hit-rate / leaderboard; this module only stores + relays.
//
// SSE: GET /channels/:id/signals/stream — long-lived response, sends
// each new signal in this channel as a `data:` event. Clients reconnect
// with Last-Event-Id (signal_id, also the event id) to resume.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "../db.ts";
import { authedAddress, AuthError, consumeStreamToken } from "../auth.ts";
import { meter, InsufficientAllowanceError } from "../billing.ts";
import { isMember } from "../lib/governance.ts";
import { HttpError } from "./channels.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";
import { buildAllowanceResponse } from "./billing.ts";
import { deliverToChannelMembers } from "../lib/webhook.ts";
import { stripControlCharsDeep } from "../../../shared/strip-control.ts";

const APPROVE_AGAIN_URL = "https://susurration.xyz/approve?amount=100";

function insufficientAllowance(c: any, e: InsufficientAllowanceError) {
  return c.json({
    error: "insufficient_allowance",
    free_credits_exhausted: true,
    allowance_usd: e.allowance_usd,
    required_usd: e.required_usd,
    approve_again_url: APPROVE_AGAIN_URL,
  }, 402);
}

// S5: feed bootstrap can return up to 200 rows. With body-limit 64KB per
// push, an attacker pushing max-size payloads could make a single feed
// response 200 × 64KB = 12.8MB — bad for terminal renderers, mobile, slow
// links. Truncate per-row payload at PAYLOAD_RENDER_CAP and replace with
// {truncated:true, size_bytes:N, preview} so the client can decide whether
// to fetch the full thing via /channels/.../signals?since=... .
// Storage is unaffected — we still keep the original. (G v0.0.4 review 🟡 #3)
const PAYLOAD_RENDER_CAP = 4096;
function truncatePayloadForFeed(p: unknown): unknown {
  let raw: string;
  try { raw = JSON.stringify(p); } catch { return { truncated: true, reason: "unserializable" }; }
  if (raw.length <= PAYLOAD_RENDER_CAP) return p;
  // For text-shaped payloads, surface a readable preview; otherwise just
  // tell the client there's more.
  const preview = typeof p === "object" && p !== null && typeof (p as any).text === "string"
    ? (p as any).text.slice(0, 256)
    : raw.slice(0, 256);
  return {
    truncated: true,
    size_bytes: raw.length,
    preview,
    fetch_via: "GET /channels/{channel_id}/signals?since=...",
  };
}

// BETA-1.b: anti-flood. Push at most 30/min/address (~1 every 2s sustained) —
// a real trader pushes a few signals per hour; bots get throttled fast.
const PUSH_PER_ADDR = { windowMs: 60_000, max: 30 };
const REACT_PER_ADDR = { windowMs: 60_000, max: 60 };
// Read-side limits — `susu feed` / `susu inbox` are interactive UIs, real
// users hit this maybe 10×/min while glancing. 60/min is generous for legit
// inbox refreshes + still chokes a "spam GET to exhaust Postgres JOINs"
// attacker (G v0.0.4 review #3).
const FEED_PER_ADDR = { windowMs: 60_000, max: 60 };
// G v0.0.4 review #1: per-user concurrent SSE cap. Each connection pins a
// pubsub subscription + an HTTP fd; with no cap a single token could open
// thousands. 5 covers the realistic case (1 inbox + 1 watch + reconnect
// during a flap). Excess attempts get HTTP 429 immediately.
const MAX_SSE_PER_ADDR = 5;
const sseConnByAddr = new Map<string, number>();

function rateLimited(c: any, e: RateLimitedError) {
  c.header("Retry-After", String(e.retryAfterSec));
  return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
}

export const signalRoutes = new Hono();

// In-process pub/sub. One process per Fly machine in v0.1; if we scale to
// multiple machines later we'll swap to LISTEN/NOTIFY on Postgres.
//
// BETA-1.c: unified event taxonomy. Every wire event has `kind` so clients
// can route by switch. Recipients are addressed by `RecipientKey` which is
// either `chan:<channel_id>` (anyone watching that channel) or
// `user:<address>` (cross-channel events for that user — friend requests,
// channel invites, system notifications). One `subscribers` map handles
// both — atomic rule, no parallel publishUser/publishChannel data structures.

// ── Event taxonomy (wire format) ──────────────────────────────────────────

export type SignalEvent = {
  kind: "signal";
  signal_id: string;
  channel_id: string;
  from_address: string;
  /** @handle of the sender if registered. Clients should prefer this for
   *  display — `from_address` is a backend identity primitive users
   *  shouldn't see in chat-like surfaces. */
  from_username: string | null;
  payload: unknown;
  created_at: string;
};

export type ReactionEvent = {
  kind: "reaction";
  reaction_id: string;
  signal_id: string;
  channel_id: string;
  from_address: string;
  from_username: string | null;
  payload: unknown;
  is_auto: boolean;
  created_at: string;
};

export type ChannelMemberAddedEvent = {
  kind: "channel_member_added";
  channel_id: string;
  address: string;
  username: string | null;
  by: string;
  created_at: string;
};

export type ChannelMemberRemovedEvent = {
  kind: "channel_member_removed";
  channel_id: string;
  address: string;
  username: string | null;
  by: string | null;
  reason: "left" | "kicked" | "unfriended" | "disbanded";
  created_at: string;
};

export type ChannelMetaChangedEvent = {
  kind: "channel_meta_changed";
  channel_id: string;
  by: string;
  method: "PUT" | "PATCH";
  size_bytes?: number;
  created_at: string;
};

export type ChannelOwnerTransferredEvent = {
  kind: "channel_owner_transferred";
  channel_id: string;
  from_address: string;
  to_address: string;
  reason: "transfer" | "auto_elected_on_leave";
  created_at: string;
};

export type FriendRequestEvent = {
  kind: "friend_request";
  request_id: string;
  from_address: string;
  from_username: string | null;
  created_at: string;
};

export type FriendAcceptedEvent = {
  kind: "friend_accepted";
  channel_id: string;
  with_address: string;
  with_username: string | null;
  auto: boolean;
  created_at: string;
};

export type FriendRemovedEvent = {
  kind: "friend_removed";
  by_address: string;
  by_username: string | null;
  channel_id: string;
  created_at: string;
};

export type ChannelInvitedEvent = {
  kind: "channel_invited";
  channel_id: string;
  by: string;
  by_username: string | null;
  channel_name: string | null;
  created_at: string;
};

export type ChannelCreatedEvent = {
  kind: "channel_created";
  channel_id: string;
  is_group: boolean;
  name: string | null;
  created_at: string;
};

export type SystemEvent = {
  kind: "system";
  message: string;
  level: "info" | "warn" | "urgent";
  created_at: string;
};

export type Event =
  | SignalEvent
  | ReactionEvent
  | ChannelMemberAddedEvent
  | ChannelMemberRemovedEvent
  | ChannelMetaChangedEvent
  | ChannelOwnerTransferredEvent
  | FriendRequestEvent
  | FriendAcceptedEvent
  | FriendRemovedEvent
  | ChannelInvitedEvent
  | ChannelCreatedEvent
  | SystemEvent;

// Sentinel pushed via the same fn() to signal "you've been ejected from the
// channel, abort the SSE stream now". Distinguished from real events by the
// __close field. (G v0.0.4 review #2)
export type EjectEvent = { __close: true; reason: string };

// ── Subscribers (unified key) ─────────────────────────────────────────────

type RecipientKey = string;  // `chan:<channel_id>` or `user:<address>`
type Subscriber = {
  address: string;
  fn: (e: Event | EjectEvent) => void;
};
const subscribers = new Map<RecipientKey, Set<Subscriber>>();

/** Live SSE subscriber counts. /health uses this. */
export function sseStats(): { channels: number; subscribers: number } {
  let total = 0;
  for (const s of subscribers.values()) total += s.size;
  return { channels: subscribers.size, subscribers: total };
}

function publish(recipient: RecipientKey, evt: Event) {
  const subs = subscribers.get(recipient);
  if (!subs) return;
  for (const s of subs) {
    try { s.fn(evt); } catch { /* never let one slow consumer break others */ }
  }
}

/** Publish to all subscribers watching this channel (channel-scope events:
 *  signal / reaction / channel_member_* / channel_meta_changed / etc). */
export function publishChannel(channelId: string, evt: Event) {
  publish(`chan:${channelId}`, evt);
}

/** Publish to all live SSE streams owned by this user (user-scope events:
 *  friend_request / friend_accepted / friend_removed / channel_invited /
 *  channel_created). Routed via the user's feed-stream subscriber, which
 *  registers a `user:<addr>` subscription on connect. */
export function publishUser(address: string, evt: Event) {
  publish(`user:${address}`, evt);
}

/** Broadcast to ALL live SSE subscribers across all channels and users.
 *  Used for system-wide announcements (version updates, maintenance, etc). */
export function publishAll(evt: Event) {
  const seen = new Set<Subscriber["fn"]>();
  for (const subs of subscribers.values()) {
    for (const s of subs) {
      // Dedup: a user subscribed to multiple channels gets one copy.
      if (seen.has(s.fn)) continue;
      seen.add(s.fn);
      try { s.fn(evt); } catch { /* never let one slow consumer break others */ }
    }
  }
}

function subscribe(
  recipient: RecipientKey,
  address: string,
  fn: (e: Event | EjectEvent) => void,
): () => void {
  let subs = subscribers.get(recipient);
  if (!subs) {
    subs = new Set();
    subscribers.set(recipient, subs);
  }
  const entry: Subscriber = { address, fn };
  subs.add(entry);
  return () => {
    subs!.delete(entry);
    if (subs!.size === 0) subscribers.delete(recipient);
  };
}

// ── Feed-stream dynamic-channel subscribe (G v0.0.6 review #1 fix) ────────
//
// Problem: feed/stream subscribes to all the user's channels at CONNECT time
// (snapshot). When a new channel is created mid-stream (auto-accept friend
// add, accept pending request, get invited to a group), the existing
// feed-stream subscriber wouldn't receive any signals from that channel —
// the user would see `friend_accepted` / `channel_invited` notification but
// no actual messages until they reconnect.
//
// Fix: feed/stream handlers register an "extender" callback in this map.
// Routes that create/join channels for a user call notifyFeedStreamsNewChannel
// which invokes each registered extender, causing live feed-streams to
// dynamically subscribe to the new channel.

export type FeedStreamMeta = {
  channel_name: string | null;
  peer: { address: string; username: string | null } | null;
};
type FeedStreamExtender = (channelId: string, meta: FeedStreamMeta) => void;
const feedStreamExtenders = new Map<string, Set<FeedStreamExtender>>();

export function notifyFeedStreamsNewChannel(
  address: string,
  channelId: string,
  meta: FeedStreamMeta,
) {
  const exts = feedStreamExtenders.get(address);
  if (!exts) return;
  for (const ext of exts) {
    try { ext(channelId, meta); } catch {}
  }
}

/** Internal: feed/stream handler registers itself; returns unregister fn. */
function registerFeedStreamExtender(address: string, ext: FeedStreamExtender): () => void {
  let s = feedStreamExtenders.get(address);
  if (!s) { s = new Set(); feedStreamExtenders.set(address, s); }
  s.add(ext);
  return () => {
    s!.delete(ext);
    if (s!.size === 0) feedStreamExtenders.delete(address);
  };
}

// ── Address logging helper ───────────────────────────────────────────────
//
// BETA-1.b post-mortem #2: don't log full base58 addresses (events table
// policy in ADR 2026-04-29 — NO full addresses). For diagnostic logs we
// truncate to first 8 chars + ellipsis; that's enough to correlate without
// publishing pubkey-as-identifier.
function logAddr(addr: string): string {
  return addr.slice(0, 8) + "…";
}

/** Externally close all SSE subscriptions for `address` on `channelId`.
 *  Called when membership changes (kick / leave / 1on1 delete) so that
 *  ex-members stop receiving new events. Without this, a kicked user's
 *  open SSE connection keeps streaming new messages — real data leak
 *  per G v0.0.4 review #2. */
export function ejectAddressFromChannel(channelId: string, address: string, reason: string) {
  const recipient = `chan:${channelId}`;
  const subs = subscribers.get(recipient);
  if (!subs) return;
  for (const s of [...subs]) {
    if (s.address === address) {
      try { s.fn({ __close: true, reason }); } catch {}
      subs.delete(s);
    }
  }
  if (subs.size === 0) subscribers.delete(recipient);
}

/** Eject `address` from EVERY channel they're subscribed to. Use when the
 *  user's account is fully wiped (future: `susu logout --hard` / soft delete). */
export function ejectAddressEverywhere(address: string, reason: string) {
  for (const [recipient, subs] of subscribers) {
    for (const s of [...subs]) {
      if (s.address === address) {
        try { s.fn({ __close: true, reason }); } catch {}
        subs.delete(s);
      }
    }
    if (subs.size === 0) subscribers.delete(recipient);
  }
}

async function withAuth(c: any) { return await authedAddress(c.req.header("authorization")); }
function authError(c: any, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

// POST /channels/:id/signals — push a signal. payload is any JSON.
signalRoutes.post("/channels/:id/signals", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");

  try { rateCheck(`push:${me}`, PUSH_PER_ADDR); }
  catch (e) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (e) {
    // BETA-1.a: bodyLimit now throws HTTPException(413) which is handled by
    // app.onError. We still defend here in case the chunked-stream path raises
    // BodyLimitError directly (some Bun/Hono edge cases) — re-throw so onError
    // converts it to a clean 413 instead of a misleading 400.
    if ((e as Error).name === "BodyLimitError") throw e;
    return c.json({ error: "invalid json body" }, 400);
  }
  // payload is the entire body — wrapped or unwrapped doesn't matter, we store as-is.
  // Common pattern: client sends {payload: {...}} OR {...} directly. Accept both.
  const rawPayload =
    typeof body === "object" && body !== null && "payload" in (body as any)
      ? (body as any).payload
      : body;
  // S5: strip ANSI escapes / C0+C1 control chars from every string in the
  // payload before persistence. This is defense-in-depth — terminal-rendering
  // clients (susu feed/watch/inbox) also strip on render. See
  // shared/strip-control.ts for what's stripped vs preserved (\n and \t are
  // kept). Without this, any agent could forge [HUMAN] tags or clear user
  // terminals via raw ANSI in payload text. (G v0.0.4 review #1)
  const payload = stripControlCharsDeep(rawPayload);

  try {
    const result = await sql.begin(async (tx) => {
      if (!(await isMember(tx, channelId, me))) throw new HttpError(403, "not a member");
      const insert = await tx<{ signal_id: string; created_at: Date }[]>`
        INSERT INTO signals(channel_id, from_address, payload)
        VALUES (${channelId}, ${me}, ${tx.json(payload as any)})
        RETURNING signal_id, created_at
      `;
      const row = insert[0]!;
      const meterOut = await meter({
        tx,
        address: me,
        channelId,
        signalId: row.signal_id,
        callType: "signal_push",
      });
      // Look up the sender's @handle so SSE / batch consumers can render
      // it directly. Cheap (single PK lookup); cached usernames hot-path.
      const u = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${me}
      `;
      const from_username = u[0]?.username ?? null;
      return {
        signal_id: row.signal_id,
        channel_id: channelId,
        from_address: me,
        from_username,
        payload,
        created_at: row.created_at.toISOString(),
        cost_usd: meterOut.cost_usd,
      };
    });

    const wireEvent = {
      kind: "signal" as const,
      signal_id: result.signal_id,
      channel_id: channelId,
      from_address: me,
      from_username: result.from_username,
      payload,
      created_at: result.created_at,
    };
    publishChannel(channelId, wireEvent);
    deliverToChannelMembers(channelId, me, wireEvent);

    const allowance_after = await buildAllowanceResponse(me);
    recordEvent({ type: "signal_push", address: me, channelId });
    void sql`UPDATE identities SET last_active_at = now() WHERE address = ${me}`.catch(() => {});
    return c.json({ ...result, allowance_after }, 201);
  } catch (e) {
    if (e instanceof InsufficientAllowanceError) {
      recordEvent({ type: "charge_failed", address: me, channelId, payload: { reason: "insufficient_allowance" } });
      return insufficientAllowance(c, e);
    }
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 403 | 404);
    throw e;
  }
});

// GET /channels/:id/signals?since=ISO&limit=N — fetch signal log
signalRoutes.get("/channels/:id/signals", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  // R4: existence-then-membership.
  const exists = await sql`SELECT 1 FROM channels WHERE channel_id = ${channelId}`;
  if (exists.length === 0) return c.json({ error: "channel not found" }, 404);
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);

  const since = c.req.query("since");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

  // JOIN identities so the CLI / agent can render @handle directly without
  // doing a second lookup. The address column stays for protocol clients
  // that care; UIs should prefer from_username and treat from_address as
  // a backend identifier.
  const rows = since
    ? await sql<any[]>`
        SELECT s.signal_id, s.channel_id, s.from_address,
               i.username AS from_username,
               s.payload, s.created_at
        FROM signals s
        LEFT JOIN identities i ON i.address = s.from_address
        WHERE s.channel_id = ${channelId} AND s.created_at > ${since}
        ORDER BY s.created_at ASC LIMIT ${limit}
      `
    : await sql<any[]>`
        SELECT s.signal_id, s.channel_id, s.from_address,
               i.username AS from_username,
               s.payload, s.created_at
        FROM signals s
        LEFT JOIN identities i ON i.address = s.from_address
        WHERE s.channel_id = ${channelId}
        ORDER BY s.created_at DESC LIMIT ${limit}
      `;
  return c.json({ signals: rows });
});

// GET /channels/:id/signals/stream — SSE
//
// R2: auth must NOT use the long-lived bearer in the query string (would leak
// to access logs). Two accepted modes:
//   - Authorization header (CLI/SDK)
//   - ?stream_token=... (single-use, 5-min TTL — POST /auth/stream-token mints)
signalRoutes.get("/channels/:id/signals/stream", async (c) => {
  let me: string;
  const headerAuth = c.req.header("authorization");
  const streamToken = c.req.query("stream_token");
  try {
    if (headerAuth) {
      me = await authedAddress(headerAuth);
    } else if (streamToken) {
      me = await consumeStreamToken(streamToken);
    } else {
      throw new AuthError(401, "missing auth (Authorization header or ?stream_token=)");
    }
  } catch (e) { return authError(c, e); }

  const channelId = c.req.param("id");
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);

  // S5: per-user concurrent SSE cap. Each connection pins fd + pubsub sub;
  // without a cap one token could open thousands. (G v0.0.4 review 🟡 #1)
  const currentConnCount = sseConnByAddr.get(me) ?? 0;
  if (currentConnCount >= MAX_SSE_PER_ADDR) {
    c.header("Retry-After", "10");
    return c.json({ error: "too_many_streams", limit: MAX_SSE_PER_ADDR }, 429);
  }
  sseConnByAddr.set(me, currentConnCount + 1);

  const connectTime = Date.now();
  const handleRow = await sql<{username: string}[]>`SELECT username FROM identities WHERE address = ${me} LIMIT 1`;
  const handle = handleRow[0]?.username ? `@${handleRow[0].username}` : logAddr(me);
  console.log(`[sse:channel] connect ${handle} channel=${channelId.slice(0, 8)}`);

  return streamSSE(c, async (stream) => {
    let aborted = false;
    let unsub = () => {};
    const queue: Event[] = [];
    let resolveWaiter: (() => void) | null = null;

    function wakeWaiter() {
      const r = resolveWaiter;
      resolveWaiter = null;
      r?.();
    }

    let ejected: { reason: string } | null = null;
    unsub = subscribe(`chan:${channelId}`, me, (evt) => {
      if ((evt as EjectEvent).__close) {
        ejected = { reason: (evt as EjectEvent).reason };
        aborted = true;
        wakeWaiter();
        return;
      }
      queue.push(evt as Event);
      wakeWaiter();
    });

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
    }, 5_000);

    stream.onAbort(() => {
      aborted = true;
      clearInterval(heartbeat);
      unsub();
      wakeWaiter();
      const dur = ((Date.now() - connectTime) / 1000).toFixed(0);
      console.log(`[sse:channel] disconnect ${handle} channel=${channelId.slice(0, 8)} after=${dur}s reason=client_abort`);
    });

    try {
      await stream.writeSSE({ event: "open", data: JSON.stringify({ channel_id: channelId }) });
      while (!aborted) {
        if (queue.length === 0) {
          // Wait until either an event arrives or onAbort fires; both wake us.
          await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          if (aborted) break;
        }
        while (queue.length > 0 && !aborted) {
          const evt = queue.shift()!;
          // SSE event name = our `kind` (signal / reaction / channel_*),
          // letting clients route by Last-Event-Id + event name. id field
          // is signal_id for signal/reaction events, channel_id otherwise
          // (so reconnect with Last-Event-Id stays meaningful per-stream).
          // Channel SSE shouldn't carry user-scope events (those go to
          // user: key), so narrowing to the channel-scope subset is safe.
          const eventName = evt.kind;
          const anyEvt = evt as any;
          const id = anyEvt.signal_id ?? anyEvt.channel_id ?? "";
          await stream.writeSSE({
            id,
            event: eventName,
            data: JSON.stringify(evt),
          });
        }
      }
      // If we were ejected (kicked / left), tell the client cleanly before
      // the SSE closes so they don't auto-reconnect into an empty channel.
      if (ejected) {
        await stream.writeSSE({ event: "ejected", data: JSON.stringify(ejected) }).catch(() => {});
      }
    } catch (err) {
      const dur = ((Date.now() - connectTime) / 1000).toFixed(0);
      console.warn(
        `[sse:channel] disconnect ${handle} channel=${channelId.slice(0, 8)} after=${dur}s reason=error: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      aborted = true;
      clearInterval(heartbeat);
      unsub();
      const c2 = (sseConnByAddr.get(me) ?? 1) - 1;
      if (c2 <= 0) sseConnByAddr.delete(me); else sseConnByAddr.set(me, c2);
    }
  });
});

// GET /signals/feed?since=ISO&limit=N — cross-channel history.
//
// Returns the caller's most recent events (signals + reactions) across every
// channel they're a member of, ordered by created_at DESC (most recent first).
// Each row carries a `kind` discriminator ("signal" | "reaction") so clients
// can dispatch rendering. Used by:
//   - human-side `susu feed` (terminal log of all my agent's chatter)
//   - human-side `susu inbox` (bubble-UI window initial bootstrap)
//   - agent-side `susu_signals_feed` MCP tool (catch up on inbox in one call)
//
// Response: { events: [...], signals: [...] }
// `events` = unified timeline (signals + reactions interleaved by time).
// `signals` = same as `events` (backward-compat alias — older CLIs read this).
signalRoutes.get("/signals/feed", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }

  // S5: feed rate limit — read-side; protects DB from spam GET (G #3).
  try { rateCheck(`feed:${me}`, FEED_PER_ADDR); }
  catch (e) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }

  // R3: input validation — bad query string should return 400, not crash to
  // 500 via SQL parse errors. Number("abc")=NaN, Math.min(NaN,...)=NaN, and
  // LIMIT NaN throws. since='garbage'::timestamptz throws. Both = client bug.
  const rawLimit = c.req.query("limit");
  const limitN = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isFinite(limitN)) {
    return c.json({ error: "invalid_limit", detail: "limit must be a finite number" }, 400);
  }
  const limit = Math.min(Math.max(Math.trunc(limitN), 1), 200);

  const since = c.req.query("since");
  if (since !== undefined) {
    const t = Date.parse(since);
    if (!Number.isFinite(t)) {
      return c.json({ error: "invalid_since", detail: "since must be ISO 8601" }, 400);
    }
  }

  // UNION signals + reactions into one timeline, ordered by created_at DESC.
  // Each row carries `kind` so clients can dispatch rendering.
  // peer subquery is attached to both branches for consistent label formatting.
  const sinceClause = since ? sql`WHERE created_at > ${since}` : sql``;
  const rows = await sql<any[]>`
    SELECT * FROM (
      SELECT 'signal'::text AS kind,
             s.signal_id,
             NULL::uuid AS reaction_id,
             s.channel_id,
             s.from_address,
             i.username AS from_username,
             s.payload,
             s.created_at,
             c.name AS channel_name,
             c.is_group AS is_group,
             NULL::uuid AS parent_signal_id,
             false AS is_auto,
             (
               SELECT json_build_object(
                 'address', cm2.address,
                 'username', i2.username
               )
               FROM channel_members cm2
               LEFT JOIN identities i2 ON i2.address = cm2.address
               WHERE cm2.channel_id = s.channel_id AND cm2.address <> ${me}
               LIMIT 1
             ) AS peer
      FROM signals s
      JOIN channel_members cm ON cm.channel_id = s.channel_id AND cm.address = ${me}
      JOIN channels c ON c.channel_id = s.channel_id
      LEFT JOIN identities i ON i.address = s.from_address

      UNION ALL

      SELECT 'reaction'::text AS kind,
             NULL::uuid AS signal_id,
             r.reaction_id,
             sig.channel_id,
             r.from_address,
             i.username AS from_username,
             r.payload,
             r.created_at,
             c.name AS channel_name,
             c.is_group AS is_group,
             r.signal_id AS parent_signal_id,
             r.is_auto,
             (
               SELECT json_build_object(
                 'address', cm2.address,
                 'username', i2.username
               )
               FROM channel_members cm2
               LEFT JOIN identities i2 ON i2.address = cm2.address
               WHERE cm2.channel_id = sig.channel_id AND cm2.address <> ${me}
               LIMIT 1
             ) AS peer
      FROM reactions r
      JOIN signals sig ON sig.signal_id = r.signal_id
      JOIN channel_members cm ON cm.channel_id = sig.channel_id AND cm.address = ${me}
      JOIN channels c ON c.channel_id = sig.channel_id
      LEFT JOIN identities i ON i.address = r.from_address

      UNION ALL

      -- Phase 10 D7 channel structural events (created / member_added /
      -- member_removed / renamed / owner_transferred). Persisted in channel_events
      -- (migration 016) so refresh recovers history. Each row kind = specific
      -- event type so frontend can render with a per-kind template.
      SELECT ce.kind::text AS kind,
             NULL::uuid AS signal_id,
             NULL::uuid AS reaction_id,
             ce.channel_id,
             ce.actor_address AS from_address,
             ce.actor_username AS from_username,
             (jsonb_build_object(
               'actor_address', ce.actor_address,
               'actor_username', ce.actor_username,
               'target_address', ce.target_address,
               'target_username', ce.target_username
             ) || COALESCE(ce.payload, '{}'::jsonb)) AS payload,
             ce.created_at,
             c.name AS channel_name,
             c.is_group AS is_group,
             NULL::uuid AS parent_signal_id,
             false AS is_auto,
             (
               SELECT json_build_object(
                 'address', cm2.address,
                 'username', i2.username
               )
               FROM channel_members cm2
               LEFT JOIN identities i2 ON i2.address = cm2.address
               WHERE cm2.channel_id = ce.channel_id AND cm2.address <> ${me}
               LIMIT 1
             ) AS peer
      FROM channel_events ce
      JOIN channel_members cm ON cm.channel_id = ce.channel_id AND cm.address = ${me}
      JOIN channels c ON c.channel_id = ce.channel_id
    ) unified
    ${sinceClause}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
  // S5: cap each row's payload so feed bootstrap stays bounded even if
  // a malicious peer pushed 64KB messages. Original stays in DB; clients
  // wanting the full row can fetch via /channels/{id}/signals.
  for (const r of rows) r.payload = truncatePayloadForFeed(r.payload);
  // `events` is the canonical key; `signals` kept for backward compat.
  return c.json({ events: rows, signals: rows });
});

// GET /signals/feed/stream — SSE fan-in across all the caller's channels.
//
// Same auth modes as the per-channel stream (header bearer or ?stream_token).
// Implementation: subscribe once per channel the user is a member of at
// connect time. Channels added during the connection won't push events to
// this stream — clients should reconnect on `susu add` / `susu accept` if
// they want the new channel included. (We document this; reconnect is cheap.)
signalRoutes.get("/signals/feed/stream", async (c) => {
  let me: string;
  const headerAuth = c.req.header("authorization");
  const streamToken = c.req.query("stream_token");
  try {
    if (headerAuth) {
      me = await authedAddress(headerAuth);
    } else if (streamToken) {
      me = await consumeStreamToken(streamToken);
    } else {
      throw new AuthError(401, "missing auth (Authorization header or ?stream_token=)");
    }
  } catch (e) { return authError(c, e); }

  // S5: per-user concurrent SSE cap (G v0.0.4 review 🟡 #1)
  const currentConnCount = sseConnByAddr.get(me) ?? 0;
  if (currentConnCount >= MAX_SSE_PER_ADDR) {
    c.header("Retry-After", "10");
    return c.json({ error: "too_many_streams", limit: MAX_SSE_PER_ADDR }, 429);
  }
  sseConnByAddr.set(me, currentConnCount + 1);

  // Snapshot the user's channels at connect time + fetch each channel's
  // display metadata (group name OR peer for 1-on-1) once. We attach this
  // to each forwarded event so the client can render `from → recipient`
  // correctly without per-event DB lookups, and without falling back to
  // myUsername when peer info is missing (G review #2).
  type ChannelMeta = {
    channel_name: string | null;
    peer: { address: string; username: string | null } | null;
  };
  const memberRows = await sql<any[]>`
    SELECT
      cm.channel_id,
      c.name AS channel_name,
      (
        SELECT json_build_object('address', cm2.address, 'username', i2.username)
        FROM channel_members cm2
        LEFT JOIN identities i2 ON i2.address = cm2.address
        WHERE cm2.channel_id = cm.channel_id AND cm2.address <> ${me}
        LIMIT 1
      ) AS peer
    FROM channel_members cm
    JOIN channels c ON c.channel_id = cm.channel_id
    WHERE cm.address = ${me}
  `;
  const channelMeta = new Map<string, ChannelMeta>();
  for (const r of memberRows) {
    channelMeta.set(r.channel_id, { channel_name: r.channel_name, peer: r.peer });
  }

  const connectTime = Date.now();
  const handleRow = await sql<{username: string}[]>`SELECT username FROM identities WHERE address = ${me} LIMIT 1`;
  const handle = handleRow[0]?.username ? `@${handleRow[0].username}` : logAddr(me);
  console.log(`[sse:feed] connect ${handle} channels=${channelMeta.size}`);

  // Mark daemon as connected on SSE join + extract daemon version from
  // User-Agent header (Phase 16 — `susurration-agent-daemon/X.Y.Z`).
  // Web SPA's EventSource also hits this endpoint with browser UA — the
  // regex only matches the daemon's UA so non-daemon connects don't pollute
  // identity.last_daemon_version. Fire-and-forget; failures don't block SSE.
  const ua = c.req.header("user-agent") ?? "";
  const daemonVersionMatch = ua.match(/susurration-agent-daemon\/(\d+\.\d+\.\d+)/);
  if (daemonVersionMatch) {
    const daemonVer = daemonVersionMatch[1]!.slice(0, 20);
    sql`UPDATE identities SET last_daemon_ping_at = now(), last_daemon_version = ${daemonVer} WHERE address = ${me}`.catch(() => {});
  } else {
    sql`UPDATE identities SET last_daemon_ping_at = now() WHERE address = ${me}`.catch(() => {});
  }

  return streamSSE(c, async (stream) => {
    let aborted = false;
    type EnrichedEvent = Event & Partial<FeedStreamMeta>;
    const queue: EnrichedEvent[] = [];
    let resolveWaiter: (() => void) | null = null;

    function wakeWaiter() {
      const r = resolveWaiter;
      resolveWaiter = null;
      r?.();
    }

    const unsubs: Array<() => void> = [];
    let ejected: { channel_id: string; reason: string } | null = null;

    // Channel-scope subscription factory. Used for snapshot subscribe at
    // connect time AND for dynamic subscribe via the extender (when the user
    // joins a new channel mid-stream — see G v0.0.6 review #1 fix).
    function subscribeChannel(channel_id: string, meta: FeedStreamMeta) {
      unsubs.push(subscribe(`chan:${channel_id}`, me, (evt) => {
        if ((evt as EjectEvent).__close) {
          // Drop the dead channel from our local meta cache and (importantly)
          // STOP enriching new events for it. Don't kill the whole stream —
          // user might still be in other channels.
          ejected = { channel_id, reason: (evt as EjectEvent).reason };
          channelMeta.delete(channel_id);
          wakeWaiter();
          return;
        }
        const e = evt as Event;
        // Cap payload only for SignalEvent (other events have small fixed
        // shapes — no need to truncate). Merge channel meta for client
        // rendering consistency.
        const payload = e.kind === "signal"
          ? truncatePayloadForFeed((e as SignalEvent).payload)
          : "payload" in e ? e.payload : undefined;
        queue.push({ ...e, ...(payload !== undefined ? { payload } : {}), ...meta });
        wakeWaiter();
      }));
    }

    // 1) snapshot subscribe — every channel the user is a member of NOW.
    for (const [channel_id, meta] of channelMeta) {
      subscribeChannel(channel_id, meta);
    }

    // 2) user-scope subscribe — friend_request / friend_accepted /
    //    friend_removed / channel_invited / channel_created come through
    //    here regardless of channel membership snapshot.
    unsubs.push(subscribe(`user:${me}`, me, (evt) => {
      if ((evt as EjectEvent).__close) return;  // user-scope can't be ejected
      queue.push(evt as Event);
      wakeWaiter();
    }));

    // 3) register extender — when route handlers create / join a channel
    //    for `me` mid-stream, add a live channel subscription so this
    //    feed-stream sees signals from it without requiring reconnect.
    const unregExtender = registerFeedStreamExtender(me, (newChannelId, newMeta) => {
      if (channelMeta.has(newChannelId)) return;  // already subscribed
      channelMeta.set(newChannelId, newMeta);
      subscribeChannel(newChannelId, newMeta);
    });
    unsubs.push(unregExtender);

    let lastDaemonPing = Date.now();
    // Must stay strictly under STALE_AFTER_SECONDS (90s) in
    // routes/daemon_state.ts — otherwise a daemon with a healthy SSE
    // connection flickers to "stale" between heartbeat-ping writes.
    // Daemon's own POST /identity/daemon-ping fires every 30 min; this
    // SSE-side write is the dense complement that keeps the stale
    // detector honest while the stream is open.
    const DAEMON_PING_INTERVAL = 60 * 1000; // 60s — keep < 90s stale threshold
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {});
      if (Date.now() - lastDaemonPing > DAEMON_PING_INTERVAL) {
        lastDaemonPing = Date.now();
        sql`UPDATE identities SET last_daemon_ping_at = now() WHERE address = ${me}`.catch(() => {});
      }
    }, 5_000);

    stream.onAbort(() => {
      aborted = true;
      clearInterval(heartbeat);
      for (const u of unsubs) u();
      wakeWaiter();
      const dur = ((Date.now() - connectTime) / 1000).toFixed(0);
      console.log(`[sse:feed] disconnect ${handle} after=${dur}s reason=client_abort`);
    });

    try {
      await stream.writeSSE({
        event: "open",
        data: JSON.stringify({ channel_count: channelMeta.size }),
      });
      while (!aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          if (aborted) break;
        }
        // Surface any ejection that arrived since the last loop iteration.
        if (ejected) {
          await stream.writeSSE({ event: "ejected", data: JSON.stringify(ejected) }).catch(() => {});
          ejected = null;
        }
        while (queue.length > 0 && !aborted) {
          const evt = queue.shift()!;
          // SSE event name = our `kind`; id = signal_id when present
          // (signal/reaction), else channel_id, else "" (friend_request has
          // no channel yet — use request_id).
          const eventName = evt.kind;
          const id =
            "signal_id" in evt ? (evt as any).signal_id :
            "channel_id" in evt && (evt as any).channel_id ? (evt as any).channel_id :
            "request_id" in evt ? (evt as any).request_id :
            "";
          await stream.writeSSE({
            id,
            event: eventName,
            data: JSON.stringify(evt),
          });
        }
      }
    } catch (err) {
      const dur = ((Date.now() - connectTime) / 1000).toFixed(0);
      console.warn(
        `[sse:feed] disconnect ${handle} after=${dur}s reason=error: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      aborted = true;
      clearInterval(heartbeat);
      for (const u of unsubs) u();
      const c2 = (sseConnByAddr.get(me) ?? 1) - 1;
      if (c2 <= 0) sseConnByAddr.delete(me); else sseConnByAddr.set(me, c2);
    }
  });
});

// POST /signals/:id/reactions — react to a signal
signalRoutes.post("/signals/:id/reactions", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const signalId = c.req.param("id");

  try { rateCheck(`react:${me}`, REACT_PER_ADDR); }
  catch (e) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }

  let body: any;
  try { body = await c.req.json(); } catch (e) {
    // Same defense as the signal-push handler — see comment there.
    if ((e as Error).name === "BodyLimitError") throw e;
    return c.json({ error: "invalid json body" }, 400);
  }
  const rawPayload = body && typeof body === "object" && "payload" in body ? body.payload : body;
  const payload = stripControlCharsDeep(rawPayload); // see signal push handler comment above
  const isAuto = !!body?.is_auto;

  try {
    const result = await sql.begin(async (tx) => {
      const sigRows = await tx<{ channel_id: string }[]>`
        SELECT channel_id FROM signals WHERE signal_id = ${signalId}
      `;
      const sig = sigRows[0];
      if (!sig) throw new HttpError(404, "signal not found");
      if (!(await isMember(tx, sig.channel_id, me))) throw new HttpError(403, "not a member");

      const ins = await tx<{ reaction_id: string; created_at: Date }[]>`
        INSERT INTO reactions(signal_id, from_address, payload, is_auto)
        VALUES (${signalId}, ${me}, ${tx.json(payload as any)}, ${isAuto})
        RETURNING reaction_id, created_at
      `;
      const row = ins[0]!;
      const meterOut = await meter({
        tx,
        address: me,
        channelId: sig.channel_id,
        signalId,
        reactionId: row.reaction_id,
        callType: "reaction_push",
      });
      // Look up @handle so SSE consumers can render directly without a
      // second DB hop. Same pattern as signal-push above.
      const u = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${me}
      `;
      const from_username = u[0]?.username ?? null;
      return {
        reaction_id: row.reaction_id,
        signal_id: signalId,
        channel_id: sig.channel_id,
        from_address: me,
        from_username,
        payload,
        is_auto: isAuto,
        created_at: row.created_at.toISOString(),
        cost_usd: meterOut.cost_usd,
      };
    });

    // BETA-1.c: broadcast reaction so anyone watching this channel sees
    // "@bob reacted to @alice's signal" without polling. Was the #1 watch
    // observability gap before this release (channel watchers saw signals
    // pushed but had no idea if anyone reacted).
    const reactionEvent = {
      kind: "reaction" as const,
      reaction_id: result.reaction_id,
      signal_id: result.signal_id,
      channel_id: result.channel_id,
      from_address: me,
      from_username: result.from_username,
      payload: result.payload,
      is_auto: result.is_auto,
      created_at: result.created_at,
    };
    publishChannel(result.channel_id, reactionEvent);
    deliverToChannelMembers(result.channel_id, me, reactionEvent);

    const allowance_after = await buildAllowanceResponse(me);
    recordEvent({ type: "reaction_push", address: me, channelId: result.channel_id, payload: { is_auto: isAuto } });
    void sql`UPDATE identities SET last_active_at = now() WHERE address = ${me}`.catch(() => {});
    return c.json({ ...result, allowance_after }, 201);
  } catch (e) {
    if (e instanceof InsufficientAllowanceError) {
      recordEvent({ type: "charge_failed", address: me, payload: { reason: "insufficient_allowance" } });
      return insufficientAllowance(c, e);
    }
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 403 | 404);
    throw e;
  }
});

// GET /signals/:id/reactions
signalRoutes.get("/signals/:id/reactions", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const signalId = c.req.param("id");

  const sigRows = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM signals WHERE signal_id = ${signalId}
  `;
  const sig = sigRows[0];
  if (!sig) return c.json({ error: "signal not found" }, 404);
  if (!(await isMember(sql, sig.channel_id, me))) return c.json({ error: "not a member" }, 403);

  const rows = await sql<any[]>`
    SELECT reaction_id, signal_id, from_address, payload, is_auto, created_at
    FROM reactions WHERE signal_id = ${signalId} ORDER BY created_at ASC
  `;
  return c.json({ reactions: rows });
});

// GET /prices?symbols=BTCUSDT,ETHUSDT — proxy Binance Futures ticker.
// No auth required (public price data). Cached 10s in-process.
let priceCache: { ts: number; data: Record<string, number> } = { ts: 0, data: {} };
const PRICE_CACHE_MS = 10_000;

signalRoutes.get("/prices", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  try { rateCheck(`ip:prices:${ip}`, { windowMs: 60_000, max: 60 }); } catch (e: any) { if (e instanceof RateLimitedError) return rateLimited(c, e); throw e; }
  const raw = c.req.query("symbols");
  if (!raw) return c.json({ error: "symbols required" }, 400);
  const wanted = new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
  if (wanted.size === 0) return c.json({ error: "symbols required" }, 400);
  if (wanted.size > 50) return c.json({ error: "max 50 symbols" }, 400);

  const now = Date.now();
  if (now - priceCache.ts > PRICE_CACHE_MS) {
    try {
      const resp = await fetch("https://fapi.binance.com/fapi/v1/ticker/price", {
        signal: AbortSignal.timeout(8_000),
      });
      const tickers = await resp.json() as { symbol: string; price: string }[];
      const map: Record<string, number> = {};
      for (const t of tickers) map[t.symbol] = parseFloat(t.price);
      priceCache = { ts: now, data: map };
    } catch {
      if (priceCache.ts === 0) return c.json({ error: "price fetch failed" }, 502);
    }
  }

  const result: Record<string, number> = {};
  for (const s of wanted) {
    if (s in priceCache.data) result[s] = priceCache.data[s];
  }
  return c.json({ prices: result });
});

// Phase 18.2 — legacy POST /positions/close (which wrote to the obsolete
// position_closes table) removed. The new handler in routes/positions.ts
// writes to the canonical `positions` table; PaperCloseQueue / agent both
// hit it. The legacy GET /positions/closed below is kept because the v0
// dashboard still overlays old position_closes rows for historical closed
// trades that predate paper_positions (migration 017).

signalRoutes.get("/positions/closed", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }

  const rows = await sql`
    SELECT signal_id, exit_reason, exit_price, exit_pnl_pct, closed_at
    FROM position_closes
    WHERE address = ${me}
    ORDER BY closed_at DESC
  `;
  return c.json({ closes: rows });
});
