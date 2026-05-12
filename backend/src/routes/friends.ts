// Friends routes — D13 locked UX.
//
// Add-friend flow:
//   1. Caller (alice) POSTs /api/friends/add {username: "bob"}
//   2. Resolve bob's address; if bob.auto_accept_friends=true → create
//      1-on-1 channel + friend_links row in one tx, return.
//   3. If bob.auto_accept_friends=false → write friend_request row, return
//      pending (bob must POST /api/friends/accept later).
//   4. Bob accept → friend_request → 1-on-1 channel + friend_links + delete request.
//
// 1-on-1 channels: is_group=false, owner=NULL (no owner concept).
// friend_links primary key = (a, b) with CHECK (a < b) → single row symmetric.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError, isValidSolanaAddress } from "../auth.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { recordEvent, hashAddress } from "../lib/events.ts";
import {
  ejectAddressFromChannel,
  publishUser,
  publishChannel,
  notifyFeedStreamsNewChannel,
} from "./signals.ts";
import { deliverToChannelMembers } from "../lib/webhook.ts";
import { stripControlCharsDeep } from "../../../shared/strip-control.ts";

export const friendRoutes = new Hono();

function authError(c: any, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

async function resolveTarget(input: string): Promise<{ address: string; username: string; auto_accept_friends: boolean } | null> {
  // Accept @handle, handle, or raw base58 address.
  const raw = String(input).trim();
  if (!raw) return null;
  if (isValidSolanaAddress(raw)) {
    const rows = await sql<{ address: string; username: string | null; auto_accept_friends: boolean }[]>`
      SELECT address, username, auto_accept_friends FROM identities WHERE address = ${raw}
    `;
    const r = rows[0];
    if (!r || !r.username) return null;
    return { address: r.address, username: r.username, auto_accept_friends: r.auto_accept_friends };
  }
  const username = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!USERNAME_RE.test(username)) return null;
  const rows = await sql<{ address: string; username: string; auto_accept_friends: boolean }[]>`
    SELECT address, username, auto_accept_friends FROM identities WHERE username = ${username}
  `;
  const r = rows[0];
  if (!r) return null;
  return r;
}

// Helper: lex order so friend_links primary key (a, b) is consistent.
function orderPair(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

// POST /friends/add { username | address }
friendRoutes.post("/friends/add", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); } catch (e) { return authError(c, e); }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const targetInput = String(body?.username ?? body?.address ?? "");
  const target = await resolveTarget(targetInput);
  if (!target) {
    recordEvent({ type: "friend_add_failed", address: me, payload: { reason: "user_not_found", input: targetInput } });
    return c.json({ error: "user_not_found", input: targetInput }, 404);
  }
  if (target.address === me) {
    recordEvent({ type: "friend_add_failed", address: me, payload: { reason: "cannot_add_self" } });
    return c.json({ error: "cannot_add_self" }, 400);
  }

  const { a, b } = orderPair(me, target.address);

  // Already friends? Idempotent: return existing channel.
  const existing = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM friend_links WHERE a = ${a} AND b = ${b}
  `;
  if (existing[0]) {
    return c.json({
      status: "already_friends",
      channel_id: existing[0].channel_id,
      target: { address: target.address, username: target.username },
    });
  }

  // Pending request from me to target? Re-issue same response.
  const pending = await sql<{ request_id: string }[]>`
    SELECT request_id FROM friend_requests WHERE from_addr = ${me} AND to_addr = ${target.address}
  `;
  if (pending[0]) {
    return c.json({
      status: "pending",
      request_id: pending[0].request_id,
      target: { address: target.address, username: target.username },
    });
  }

  // Need my @handle to surface in publishUser events sent to target.
  const myRow = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${me}
  `;
  const myUsername = myRow[0]?.username ?? null;

  // If target has auto_accept_friends=true → create channel + link in one tx.
  if (target.auto_accept_friends) {
    const result = await sql.begin(async (tx) => {
      // 1-on-1 channel: is_group=false, owner=NULL (no group owner).
      const ch = await tx<{ channel_id: string }[]>`
        INSERT INTO channels(name, created_by, owner, is_group)
        VALUES (NULL, ${me}, NULL, false)
        RETURNING channel_id
      `;
      const channel_id = ch[0]!.channel_id;
      await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${me})`;
      await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${target.address})`;
      await tx`
        INSERT INTO friend_links(a, b, channel_id) VALUES (${a}, ${b}, ${channel_id})
      `;
      return { channel_id };
    });
    recordEvent({ type: "friend_add_accepted", address: me, channelId: result.channel_id, payload: { auto: true } });
    // BETA-1.c: tell BOTH sides' user-scope feed-streams + dynamically wire
    // their existing feed-stream subscribers to the new 1-on-1 channel
    // (G v0.0.6 review #1 fix). Without these notifies, users would have to
    // reconnect to see the new friend appear / receive its first messages.
    const createdAt = new Date().toISOString();
    publishUser(me, {
      kind: "friend_accepted",
      channel_id: result.channel_id,
      with_address: target.address,
      with_username: target.username,
      auto: true,
      created_at: createdAt,
    });
    publishUser(target.address, {
      kind: "friend_accepted",
      channel_id: result.channel_id,
      with_address: me,
      with_username: myUsername,
      auto: true,
      created_at: createdAt,
    });
    notifyFeedStreamsNewChannel(me, result.channel_id, {
      channel_name: null,
      peer: { address: target.address, username: target.username },
    });
    notifyFeedStreamsNewChannel(target.address, result.channel_id, {
      channel_name: null,
      peer: { address: me, username: myUsername },
    });

    // @demo welcome signal — lets the new user's daemon test connectivity
    // and explains what @demo does before the first real signal arrives.
    if (target.username === "demo") {
      const welcomePayload = stripControlCharsDeep({
        type: "welcome",
        source_id: "demo-welcome",
        message:
          "Connected! I'm @demo, powered by the GS PRO scanner. " +
          "I monitor Binance Futures for funding-rate flips combined with rising open interest, " +
          "then push LONG signals when both conditions trigger. " +
          "Signal frequency varies — typically 1-5 per day depending on market conditions. " +
          "Your agent should react to this message to confirm the connection is working.",
        test_connectivity: true,
      });
      const welcome = await sql<{ signal_id: string; created_at: Date }[]>`
        INSERT INTO signals(channel_id, from_address, payload)
        VALUES (${result.channel_id}, ${target.address}, ${sql.json(welcomePayload as any)})
        RETURNING signal_id, created_at
      `;
      if (welcome[0]) {
        const wEvt = {
          kind: "signal" as const,
          signal_id: welcome[0].signal_id,
          channel_id: result.channel_id,
          from_address: target.address,
          from_username: "demo",
          payload: welcomePayload,
          created_at: welcome[0].created_at.toISOString(),
        };
        publishChannel(result.channel_id, wEvt);
        deliverToChannelMembers(result.channel_id, target.address, wEvt);
      }
    }

    return c.json({
      status: "added",
      channel_id: result.channel_id,
      target: { address: target.address, username: target.username },
    }, 201);
  }

  // target.auto_accept_friends=false → write friend_request, await accept.
  const inserted = await sql<{ request_id: string }[]>`
    INSERT INTO friend_requests(from_addr, to_addr) VALUES (${me}, ${target.address})
    RETURNING request_id
  `;
  recordEvent({ type: "friend_add_request", address: me, payload: {} });
  // Notify target's user-scope feed-stream so their inbox UI lights up
  // ("@alice wants to connect — accept?").
  publishUser(target.address, {
    kind: "friend_request",
    request_id: inserted[0]!.request_id,
    from_address: me,
    from_username: myUsername,
    created_at: new Date().toISOString(),
  });
  return c.json({
    status: "pending",
    request_id: inserted[0]!.request_id,
    target: { address: target.address, username: target.username },
  }, 201);
});

// POST /friends/accept { username | address } — only when caller turned auto_accept off.
friendRoutes.post("/friends/accept", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); } catch (e) { return authError(c, e); }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const fromInput = String(body?.username ?? body?.address ?? "");
  const from = await resolveTarget(fromInput);
  if (!from) return c.json({ error: "user_not_found", input: fromInput }, 404);

  const { a, b } = orderPair(me, from.address);

  const result = await sql.begin(async (tx) => {
    const req = await tx<{ request_id: string }[]>`
      SELECT request_id FROM friend_requests WHERE from_addr = ${from.address} AND to_addr = ${me}
    `;
    if (!req[0]) return { error: "no_pending_request" as const };
    // Same DDL as the auto-accept path.
    const ch = await tx<{ channel_id: string }[]>`
      INSERT INTO channels(name, created_by, owner, is_group)
      VALUES (NULL, ${from.address}, NULL, false)
      RETURNING channel_id
    `;
    const channel_id = ch[0]!.channel_id;
    await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${me})`;
    await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${from.address})`;
    await tx`INSERT INTO friend_links(a, b, channel_id) VALUES (${a}, ${b}, ${channel_id})`;
    await tx`DELETE FROM friend_requests WHERE request_id = ${req[0]!.request_id}`;
    return { channel_id };
  });

  if ("error" in result) return c.json({ error: result.error }, 404);
  recordEvent({ type: "friend_add_accepted", address: me, channelId: result.channel_id, payload: { auto: false } });
  // BETA-1.c: notify both sides + dynamically wire feed-streams.
  const myRow = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${me}
  `;
  const myUsername = myRow[0]?.username ?? null;
  const createdAt = new Date().toISOString();
  publishUser(me, {
    kind: "friend_accepted",
    channel_id: result.channel_id,
    with_address: from.address,
    with_username: from.username,
    auto: false,
    created_at: createdAt,
  });
  publishUser(from.address, {
    kind: "friend_accepted",
    channel_id: result.channel_id,
    with_address: me,
    with_username: myUsername,
    auto: false,
    created_at: createdAt,
  });
  notifyFeedStreamsNewChannel(me, result.channel_id, {
    channel_name: null,
    peer: { address: from.address, username: from.username },
  });
  notifyFeedStreamsNewChannel(from.address, result.channel_id, {
    channel_name: null,
    peer: { address: me, username: myUsername },
  });
  return c.json({ status: "accepted", channel_id: result.channel_id, friend: { address: from.address, username: from.username } }, 201);
});

// POST /friends/remove { username | address } — silent: counterpart channel disappears.
friendRoutes.post("/friends/remove", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); } catch (e) { return authError(c, e); }
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const targetInput = String(body?.username ?? body?.address ?? "");
  const target = await resolveTarget(targetInput);
  if (!target) return c.json({ error: "user_not_found" }, 404);

  const { a, b } = orderPair(me, target.address);
  const result = await sql.begin(async (tx) => {
    const link = await tx<{ channel_id: string }[]>`
      DELETE FROM friend_links WHERE a = ${a} AND b = ${b} RETURNING channel_id
    `;
    if (!link[0]) return { found: false as const };
    // Cascade delete channel + members + signals (ON DELETE CASCADE on FK chain).
    await tx`DELETE FROM channels WHERE channel_id = ${link[0]!.channel_id}`;
    return { found: true as const, channel_id: link[0]!.channel_id };
  });
  if (!result.found) return c.json({ error: "not_friends" }, 404);
  // Close any active SSE subscription either side has on this 1-on-1 channel.
  // Both sides need to know — me + the now-ex-friend (target.address). The
  // channel itself is gone (CASCADE deleted), so the eject is mostly a clean
  // FYI; without it, the open SSE just idles with no events. (G v0.0.4 #2)
  ejectAddressFromChannel(result.channel_id, me, "unfriended");
  ejectAddressFromChannel(result.channel_id, target.address, "unfriended");
  recordEvent({ type: "friend_remove", address: me, channelId: result.channel_id });
  // BETA-1.c: tell the ex-friend's user-scope feed-stream so their inbox
  // shows "@me unfriended you, channel removed". The eject above closes
  // their channel-scope sub but doesn't tell their user-scope sub anything.
  const myRow = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${me}
  `;
  publishUser(target.address, {
    kind: "friend_removed",
    by_address: me,
    by_username: myRow[0]?.username ?? null,
    channel_id: result.channel_id,
    created_at: new Date().toISOString(),
  });
  return c.json({ status: "removed", channel_id: result.channel_id });
});

// GET /friends — list of (username, address, channel_id).
friendRoutes.get("/friends", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization")); } catch (e) { return authError(c, e); }
  const rows = await sql<{ friend_address: string; friend_username: string | null; channel_id: string; created_at: Date }[]>`
    SELECT
      CASE WHEN fl.a = ${me} THEN fl.b ELSE fl.a END AS friend_address,
      i.username AS friend_username,
      fl.channel_id,
      fl.created_at
    FROM friend_links fl
    JOIN identities i ON i.address = (CASE WHEN fl.a = ${me} THEN fl.b ELSE fl.a END)
    WHERE fl.a = ${me} OR fl.b = ${me}
    ORDER BY fl.created_at DESC
  `;
  return c.json({ friends: rows });
});

// GET /friends/requests — pending incoming friend requests (when auto_accept=off).
friendRoutes.get("/friends/requests", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization"));} catch (e) { return authError(c, e); }
  const rows = await sql<{ request_id: string; from_addr: string; from_username: string | null; created_at: Date }[]>`
    SELECT fr.request_id, fr.from_addr, i.username AS from_username, fr.created_at
    FROM friend_requests fr
    JOIN identities i ON i.address = fr.from_addr
    WHERE fr.to_addr = ${me}
    ORDER BY fr.created_at DESC
  `;
  return c.json({ requests: rows });
});

// GET /friends/requests/outgoing — friend requests this user has sent that
// are still pending (recipient has auto_accept=false and hasn't accepted).
// Lets a caller's agent answer "is my add to @alice still waiting?".
friendRoutes.get("/friends/requests/outgoing", async (c) => {
  let me: string;
  try { me = await authedAddress(c.req.header("authorization"));} catch (e) { return authError(c, e); }
  const rows = await sql<{ request_id: string; to_addr: string; to_username: string | null; created_at: Date }[]>`
    SELECT fr.request_id, fr.to_addr, i.username AS to_username, fr.created_at
    FROM friend_requests fr
    JOIN identities i ON i.address = fr.to_addr
    WHERE fr.from_addr = ${me}
    ORDER BY fr.created_at DESC
  `;
  return c.json({ requests: rows });
});

void hashAddress; // re-export hint for events module side-effect
