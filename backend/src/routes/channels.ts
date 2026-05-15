// Channel routes — D7 v0.6 + D13 open protocol framework.
//
// Two channel types:
//   - group (is_group=true): created via POST /channels, has owner concept,
//     supports kick / invite / transfer-owner / meta KV
//   - 1-on-1 (is_group=false): created via POST /friends/add (in routes/friends.ts),
//     no owner concept, kick/invite/transfer-owner/meta-write all 409
//
// Owner mechanics (D7 v0.6):
//   - on create: owner = created_by
//   - on owner leave: auto-elect earliest-joined remaining member (no vote)
//   - on transfer: direct endpoint, owner-only call
// No 24h cooldown (D13 deleted last_kick_at). Agents can write
// channel.meta.rules.kick_cooldown_hours if they want a soft rule, but server
// doesn't enforce.

import { Hono } from "hono";
import type { Context } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError, isValidSolanaAddress } from "../auth.ts";
import { config } from "../config.ts";
import {
  isMember, isBanned, memberCount, isGroupChannel, earliestJoinedMember,
} from "../lib/governance.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { recordEvent } from "../lib/events.ts";
import { insertChannelEvent } from "../lib/channel_events.ts";
import {
  ejectAddressFromChannel,
  publishChannel,
  publishUser,
  notifyFeedStreamsNewChannel,
} from "./signals.ts";

const MAX_CHANNELS_PER_ADDRESS = 5;
const INVITE_PER_ADDR = { windowMs: 60_000, max: 30 };
const RENAME_RATE = { windowMs: 600_000, max: 3 };  // 3 renames per 10 min

// ─── Default group name generator ────────────────────────────────────────
const NAME_WORDS = [
  "alpha", "atlas", "bolt", "cipher", "delta", "echo", "flux", "gamma",
  "helix", "ion", "jade", "kite", "lunar", "mesa", "nova", "orbit",
  "pulse", "quartz", "relay", "spark", "tide", "ultra", "vibe", "wave",
  "xenon", "yield", "zero", "arc", "base", "core", "dawn", "edge",
];

function generateGroupName(): string {
  const word = NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)];
  const num = String(Math.floor(Math.random() * 900) + 100); // 100-999
  return `susu-${word}-${num}`;
}

export const channelRoutes = new Hono();

class HttpError extends Error {
  constructor(public status: number, public reason: string) { super(reason); }
}
export { HttpError };

async function withAuth(c: Context) {
  return await authedAddress(c.req.header("authorization"));
}

function authError(c: Context, e: unknown) {
  if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
  throw e;
}

function rateLimited(c: Context, e: RateLimitedError) {
  c.header("Retry-After", String(e.retryAfterSec));
  return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
}

const NOT_SUPPORTED_FOR_1ON1 = { error: "not_supported_for_1on1", reason: "this endpoint is for group channels only" };

// ─── POST /channels — create group channel ────────────────────────────────
channelRoutes.post("/channels", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const name = body?.name ? String(body.name).slice(0, 80) : generateGroupName();

  try {
    const channelId = await sql.begin(async (tx) => {
      // BETA-1.c: cap created groups per address. is_group=true only — 1-on-1
      // channels (created via /friends/add) don't count.
      const cnt = await tx<{ c: string }[]>`
        SELECT count(*)::text AS c
        FROM channels WHERE created_by = ${me} AND is_group = true
      `;
      const owned = Number(cnt[0]?.c ?? 0);
      if (owned >= MAX_CHANNELS_PER_ADDRESS) {
        throw new HttpError(409, `you already created ${owned} groups (max ${MAX_CHANNELS_PER_ADDRESS}); leave one before creating more`);
      }
      const rows = await tx<{ channel_id: string }[]>`
        INSERT INTO channels(name, created_by, owner, is_group)
        VALUES (${name}, ${me}, ${me}, true)
        RETURNING channel_id
      `;
      const id = rows[0]!.channel_id;
      await tx`INSERT INTO channel_members(channel_id, address) VALUES (${id}, ${me})`;
      return id;
    });
    recordEvent({ type: "channel_create", address: me, channelId, payload: { is_group: true, has_name: !!name } });
    // Phase 10 D7: persist channel_created so /signals/feed REST query can render
    // "X created group Y" history (not just SSE live push).
    {
      const meRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${me}`;
      insertChannelEvent({
        channelId,
        kind: "channel_created",
        actorAddress: me,
        actorUsername: meRow[0]?.username ?? null,
        payload: { name: name ?? null, is_group: true },
      });
    }
    // BETA-1.c: surface the new channel to creator's live feed-stream so they
    // see it without reconnect, and broadcast a `channel_created` user-scope
    // event so the inbox UI can highlight it.
    const createdAt = new Date().toISOString();
    publishUser(me, {
      kind: "channel_created",
      channel_id: channelId,
      is_group: true,
      name,
      created_at: createdAt,
    });
    notifyFeedStreamsNewChannel(me, channelId, { channel_name: name, peer: null });
    return c.json({ channel_id: channelId, owner: me, is_group: true }, 201);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 409);
    throw e;
  }
});

// ─── GET /channels/groups — list caller's group channels ──────────────────
channelRoutes.get("/channels/groups", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const rows = await sql`
    SELECT c.channel_id, c.name, c.owner, c.created_at,
           (SELECT count(*)::int FROM channel_members cm2 WHERE cm2.channel_id = c.channel_id) AS member_count
    FROM channels c
    JOIN channel_members cm ON cm.channel_id = c.channel_id
    WHERE cm.address = ${me} AND c.is_group = true
    ORDER BY c.created_at DESC
  `;
  return c.json({ groups: rows });
});

// ─── GET /channels/:id ────────────────────────────────────────────────────
channelRoutes.get("/channels/:id", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");

  const rows = await sql`
    SELECT channel_id, name, created_by, owner, is_group, meta, created_at
    FROM channels WHERE channel_id = ${channelId}
  `;
  if (rows.length === 0) return c.json({ error: "channel not found" }, 404);
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);
  return c.json(rows[0]);
});

// ─── GET /channels/:id/members ─────────────────────────────────────────────
channelRoutes.get("/channels/:id/members", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");

  const exists = await sql`SELECT 1 FROM channels WHERE channel_id = ${channelId}`;
  if (exists.length === 0) return c.json({ error: "channel not found" }, 404);
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);
  const rows = await sql<{ address: string; joined_at: Date }[]>`
    SELECT cm.address, cm.joined_at, i.username
    FROM channel_members cm
    LEFT JOIN identities i ON i.address = cm.address
    WHERE channel_id = ${channelId} ORDER BY cm.joined_at ASC
  `;
  return c.json({ members: rows });
});

// ─── POST /channels/:id/invite (group only) ────────────────────────────────
channelRoutes.post("/channels/:id/invite", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);

  let target = String(body?.address ?? "");
  if (!target && body?.username) {
    const row = await sql<{ address: string }[]>`SELECT address FROM identities WHERE username = ${String(body.username).toLowerCase().replace(/^@/, "")} LIMIT 1`;
    if (row.length === 0) return c.json({ error: "user not found" }, 404);
    target = row[0]!.address;
  }

  if (!isValidSolanaAddress(target)) return c.json({ error: "invalid solana address or username" }, 400);

  try { rateCheck(`invite:${me}`, INVITE_PER_ADDR); }
  catch (e) {
    if (e instanceof RateLimitedError) return rateLimited(c, e);
    throw e;
  }

  let channelName: string | null = null;
  let targetUsername: string | null = null;
  let inviterUsername: string | null = null;
  try {
    await sql.begin(async (tx) => {
      const isGroup = await isGroupChannel(tx, channelId);
      if (isGroup === null) throw new HttpError(404, "channel not found");
      if (isGroup === false) throw new HttpError(409, "not_supported_for_1on1");
      if (!(await isMember(tx, channelId, me))) throw new HttpError(403, "not a member");
      if (await isBanned(tx, channelId, target)) throw new HttpError(409, "address is banned from this channel");
      const count = await memberCount(tx, channelId);
      if (count >= config.channelMaxMembers) throw new HttpError(409, `channel is full (max ${config.channelMaxMembers})`);

      await tx`INSERT INTO identities(address) VALUES (${target}) ON CONFLICT (address) DO NOTHING`;
      const ins = await tx`
        INSERT INTO channel_members(channel_id, address) VALUES (${channelId}, ${target})
        ON CONFLICT (channel_id, address) DO NOTHING
        RETURNING address
      `;
      if (ins.length === 0) throw new HttpError(409, "already a member");
      // Fetch display info for SSE event payloads (one trip, in-tx).
      const chRow = await tx<{ name: string | null }[]>`
        SELECT name FROM channels WHERE channel_id = ${channelId}
      `;
      channelName = chRow[0]?.name ?? null;
      const ids = await tx<{ address: string; username: string | null }[]>`
        SELECT address, username FROM identities
        WHERE address IN (${target}, ${me})
      `;
      for (const r of ids) {
        if (r.address === target) targetUsername = r.username;
        if (r.address === me) inviterUsername = r.username;
      }
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 403 | 404 | 409 | 400);
    throw e;
  }
  recordEvent({ type: "channel_invite", address: me, channelId });
  // Phase 10 D7: persist channel_member_added.
  insertChannelEvent({
    channelId,
    kind: "channel_member_added",
    actorAddress: me,
    actorUsername: inviterUsername,
    targetAddress: target,
    targetUsername: targetUsername,
  });
  // BETA-1.c: broadcast member-add to existing channel members so anyone
  // watching sees "@bob just joined", and notify the invitee's user-scope
  // feed-stream so their inbox lights up. Also wire dynamic subscribe so
  // their live feed-stream starts seeing this channel's signals.
  const createdAt = new Date().toISOString();
  publishChannel(channelId, {
    kind: "channel_member_added",
    channel_id: channelId,
    address: target,
    username: targetUsername,
    by: me,
    created_at: createdAt,
  });
  publishUser(target, {
    kind: "channel_invited",
    channel_id: channelId,
    by: me,
    by_username: inviterUsername,
    channel_name: channelName,
    created_at: createdAt,
  });
  notifyFeedStreamsNewChannel(target, channelId, { channel_name: channelName, peer: null });
  return c.json({ ok: true, channel_id: channelId, added: target });
});

// ─── POST /channels/:id/leave ──────────────────────────────────────────────
//   - 1-on-1: cascade delete channel + friend_links row (counterpart sees disappear)
//   - group: regular leave; if owner leaves, auto-elect earliest-joined remaining
//     member as new owner (D7 v0.6, no NULL deadlock)
channelRoutes.post("/channels/:id/leave", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");

  const result = await sql.begin(async (tx) => {
    const ch = await tx<{ owner: string | null; is_group: boolean }[]>`
      SELECT owner, is_group FROM channels WHERE channel_id = ${channelId} FOR UPDATE
    `;
    if (!ch[0]) return { found: false as const };

    if (ch[0].is_group === false) {
      // 1-on-1: any leave deletes the entire channel + its friend_link.
      // friend_links has ON DELETE CASCADE on channel_id, so a single channel delete
      // cascades to friend_links + channel_members + signals.
      await tx`DELETE FROM channels WHERE channel_id = ${channelId}`;
      return { found: true as const, was_1on1: true as const, ownerHandover: null };
    }

    // group leave
    await tx`
      DELETE FROM channel_members WHERE channel_id = ${channelId} AND address = ${me}
    `;

    let ownerHandover: string | null = null;
    if (ch[0].owner === me) {
      // D7 v0.6: auto-elect earliest-joined remaining member as new owner.
      const next = await earliestJoinedMember(tx, channelId);
      if (next) {
        await tx`UPDATE channels SET owner = ${next} WHERE channel_id = ${channelId}`;
        ownerHandover = next;
      } else {
        // No members left — cleanup below will disband.
        await tx`UPDATE channels SET owner = NULL WHERE channel_id = ${channelId}`;
      }
    }

    const remaining = await memberCount(tx, channelId);
    if (remaining === 0) {
      await tx`DELETE FROM channels WHERE channel_id = ${channelId}`;
      return { found: true as const, was_1on1: false as const, disbanded: true as const, ownerHandover };
    }
    return { found: true as const, was_1on1: false as const, disbanded: false as const, ownerHandover };
  });

  if (!result.found) return c.json({ error: "channel not found" }, 404);
  if (!result.was_1on1 && result.ownerHandover) {
    recordEvent({ type: "owner_auto_elected", address: me, channelId, payload: { handed_to_hash: undefined /* avoid extra hashing inside lib */ } });
  }
  // BETA-1.c: broadcast leave so remaining channel members see member list
  // shrink in their watch/feed. Also broadcast owner-transfer if D7 v0.6
  // auto-election kicked in. Order matters: send removed BEFORE we close
  // `me`'s own subscription (the channel pubsub map still has `me` here).
  const createdAt = new Date().toISOString();
  if (!result.was_1on1) {
    // Look up `me`'s username for member_removed payload.
    const u = await sql<{ username: string | null }[]>`
      SELECT username FROM identities WHERE address = ${me}
    `;
    publishChannel(channelId, {
      kind: "channel_member_removed",
      channel_id: channelId,
      address: me,
      username: u[0]?.username ?? null,
      by: null,           // self-leave
      reason: "left",
      created_at: createdAt,
    });
    // Phase 10 D7: persist self-leave.
    insertChannelEvent({
      channelId,
      kind: "channel_member_removed",
      actorAddress: me,
      actorUsername: u[0]?.username ?? null,
      targetAddress: me,
      targetUsername: u[0]?.username ?? null,
      payload: { reason: "left" },
    });
    if (result.ownerHandover) {
      publishChannel(channelId, {
        kind: "channel_owner_transferred",
        channel_id: channelId,
        from_address: me,
        to_address: result.ownerHandover,
        reason: "auto_elected_on_leave",
        created_at: createdAt,
      });
      // Phase 10 D7: persist auto-owner-handover.
      const newOwnerRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${result.ownerHandover}`;
      insertChannelEvent({
        channelId,
        kind: "channel_owner_transferred",
        actorAddress: me,
        actorUsername: u[0]?.username ?? null,
        targetAddress: result.ownerHandover,
        targetUsername: newOwnerRow[0]?.username ?? null,
        payload: { reason: "auto_elected_on_leave" },
      });
    }
  }
  // Close any active SSE subscription `me` has on this channel. For 1-on-1
  // we also need to close the counterpart's subscription because the channel
  // no longer exists (CASCADE deleted), but we don't know the counterpart's
  // address here cheaply — they'll see their next push fail with 404 and
  // their existing SSE will idle until heartbeat-write-fail. (G v0.0.4 #2)
  ejectAddressFromChannel(channelId, me, "left");
  recordEvent({ type: "channel_leave", address: me, channelId, payload: { was_1on1: result.was_1on1 } });
  return c.json({ ok: true, ...result });
});

// ─── POST /channels/:id/kick (group only, owner only, NO cooldown) ─────────
channelRoutes.post("/channels/:id/kick", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const target = String(body?.address ?? "");

  if (!isValidSolanaAddress(target)) return c.json({ error: "invalid solana address" }, 400);
  if (target === me) return c.json({ error: "cannot kick yourself" }, 400);

  try {
    await sql.begin(async (tx) => {
      const ch = await tx<{ owner: string | null; is_group: boolean }[]>`
        SELECT owner, is_group FROM channels WHERE channel_id = ${channelId} FOR UPDATE
      `;
      if (!ch[0]) throw new HttpError(404, "channel not found");
      if (ch[0].is_group === false) throw new HttpError(409, "not_supported_for_1on1");
      if (ch[0].owner !== me) throw new HttpError(403, "only owner may kick");
      if (!(await isMember(tx, channelId, target))) throw new HttpError(404, "target is not a member");

      await tx`DELETE FROM channel_members WHERE channel_id = ${channelId} AND address = ${target}`;
      await tx`
        INSERT INTO channel_ban_list(channel_id, address, banned_by)
        VALUES (${channelId}, ${target}, ${me})
        ON CONFLICT (channel_id, address) DO NOTHING
      `;
      await tx`
        INSERT INTO kick_history(channel_id, kicked_address, kicked_by)
        VALUES (${channelId}, ${target}, ${me})
      `;
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 400 | 403 | 404 | 409);
    throw e;
  }
  // BETA-1.c: broadcast removal to remaining channel members so their watch
  // sees "@bob was kicked by @alice". Send BEFORE eject so the channel's
  // pubsub map still routes; eject removes only the kicked user's own sub.
  const tu = await sql<{ username: string | null }[]>`
    SELECT username FROM identities WHERE address = ${target}
  `;
  publishChannel(channelId, {
    kind: "channel_member_removed",
    channel_id: channelId,
    address: target,
    username: tu[0]?.username ?? null,
    by: me,
    reason: "kicked",
    created_at: new Date().toISOString(),
  });
  // Phase 10 D7: persist kick.
  {
    const meRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${me}`;
    insertChannelEvent({
      channelId,
      kind: "channel_member_removed",
      actorAddress: me,
      actorUsername: meRow[0]?.username ?? null,
      targetAddress: target,
      targetUsername: tu[0]?.username ?? null,
      payload: { reason: "kicked" },
    });
  }
  // Close any active SSE subscription that the kicked user has on THIS
  // channel. Without this, their open `susu watch` / `susu feed -f` keeps
  // streaming new messages — real data leak (G v0.0.4 review #2).
  ejectAddressFromChannel(channelId, target, "kicked");
  recordEvent({ type: "channel_kick", address: me, channelId });
  return c.json({ ok: true, kicked: target });
});

// ─── POST /channels/:id/transfer-owner (group only, owner only) ────────────
channelRoutes.post("/channels/:id/transfer-owner", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  // Accept either { candidate_address } or { username } resolved here.
  let candidate = String(body?.candidate_address ?? "");
  if (!candidate && body?.username) {
    const uname = String(body.username).replace(/^@/, "").toLowerCase();
    const r = await sql<{ address: string }[]>`SELECT address FROM identities WHERE username = ${uname}`;
    if (r[0]) candidate = r[0].address;
  }
  if (!isValidSolanaAddress(candidate)) {
    return c.json({ error: "invalid candidate (need address or @username)" }, 400);
  }

  try {
    await sql.begin(async (tx) => {
      const ch = await tx<{ owner: string | null; is_group: boolean }[]>`
        SELECT owner, is_group FROM channels WHERE channel_id = ${channelId} FOR UPDATE
      `;
      if (!ch[0]) throw new HttpError(404, "channel not found");
      if (ch[0].is_group === false) throw new HttpError(409, "not_supported_for_1on1");
      if (ch[0].owner !== me) throw new HttpError(403, "only owner may transfer");
      if (!(await isMember(tx, channelId, candidate))) {
        throw new HttpError(400, "candidate must be a current member");
      }
      await tx`UPDATE channels SET owner = ${candidate} WHERE channel_id = ${channelId}`;
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 400 | 403 | 404 | 409);
    throw e;
  }
  recordEvent({ type: "transfer_owner", address: me, channelId });
  publishChannel(channelId, {
    kind: "channel_owner_transferred",
    channel_id: channelId,
    from_address: me,
    to_address: candidate,
    reason: "transfer",
    created_at: new Date().toISOString(),
  });
  // Phase 10 D7: persist explicit owner transfer.
  {
    const rows = await sql<{ address: string; username: string | null }[]>`
      SELECT address, username FROM identities WHERE address IN (${me}, ${candidate})
    `;
    const meName = rows.find(r => r.address === me)?.username ?? null;
    const candName = rows.find(r => r.address === candidate)?.username ?? null;
    insertChannelEvent({
      channelId,
      kind: "channel_owner_transferred",
      actorAddress: me,
      actorUsername: meName,
      targetAddress: candidate,
      targetUsername: candName,
      payload: { reason: "transfer" },
    });
  }
  return c.json({ ok: true, channel_id: channelId, new_owner: candidate });
});

// ─── POST /channels/:id/rename (group only, owner only) ──────────────────
channelRoutes.post("/channels/:id/rename", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const newName = body?.name ? String(body.name).trim().slice(0, 80) : "";
  if (!newName) return c.json({ error: "name is required (1-80 chars)" }, 400);

  try { rateCheck(`rename:${me}`, RENAME_RATE); }
  catch (e) {
    if (e instanceof RateLimitedError) return rateLimited(c, e);
    throw e;
  }

  let oldName: string | null = null;
  try {
    await sql.begin(async (tx) => {
      const ch = await tx<{ owner: string | null; is_group: boolean; name: string | null }[]>`
        SELECT owner, is_group, name FROM channels WHERE channel_id = ${channelId} FOR UPDATE
      `;
      if (!ch[0]) throw new HttpError(404, "channel not found");
      if (ch[0].is_group === false) throw new HttpError(409, "not_supported_for_1on1");
      if (ch[0].owner !== me) throw new HttpError(403, "only owner may rename");
      oldName = ch[0].name;
      await tx`UPDATE channels SET name = ${newName} WHERE channel_id = ${channelId}`;
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.reason }, e.status as 400 | 403 | 404 | 409);
    throw e;
  }
  recordEvent({ type: "channel_rename", address: me, channelId, payload: { old_name: oldName, new_name: newName } });
  publishChannel(channelId, {
    kind: "channel_renamed",
    channel_id: channelId,
    old_name: oldName,
    new_name: newName,
    by: me,
    created_at: new Date().toISOString(),
  });
  // Phase 10 D7: persist rename.
  {
    const meRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${me}`;
    insertChannelEvent({
      channelId,
      kind: "channel_renamed",
      actorAddress: me,
      actorUsername: meRow[0]?.username ?? null,
      payload: { old_name: oldName, new_name: newName },
    });
  }
  return c.json({ ok: true, channel_id: channelId, name: newName });
});

// ─── Channel meta KV (D13 Class 3 primitive) ───────────────────────────────
// GET: any member; PUT/PATCH: owner only; group only (1-on-1 has no owner)

channelRoutes.get("/channels/:id/meta", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const exists = await sql`SELECT 1 FROM channels WHERE channel_id = ${channelId}`;
  if (exists.length === 0) return c.json({ error: "channel not found" }, 404);
  if (!(await isMember(sql, channelId, me))) return c.json({ error: "not a member" }, 403);
  const rows = await sql<{ meta: any }[]>`SELECT meta FROM channels WHERE channel_id = ${channelId}`;
  return c.json({ meta: rows[0]?.meta ?? {} });
});

async function metaWriteGuard(tx: any, channelId: string, me: string): Promise<{ ok: true } | { error: { status: number; body: any } }> {
  const ch = await tx<{ owner: string | null; is_group: boolean }[]>`
    SELECT owner, is_group FROM channels WHERE channel_id = ${channelId} FOR UPDATE
  `;
  if (!ch[0]) return { error: { status: 404, body: { error: "channel not found" } } };
  if (ch[0].is_group === false) return { error: { status: 409, body: NOT_SUPPORTED_FOR_1ON1 } };
  if (ch[0].owner !== me) return { error: { status: 403, body: { error: "only owner may write meta" } } };
  return { ok: true };
}

channelRoutes.put("/channels/:id/meta", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  if (typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "meta must be a JSON object" }, 400);
  }
  // Limit JSON size to 16KB so a malicious owner can't bloat the DB.
  const serialized = JSON.stringify(body);
  if (serialized.length > 16 * 1024) {
    return c.json({ error: "meta too large (max 16KB)" }, 413);
  }

  const result = await sql.begin(async (tx) => {
    const guard = await metaWriteGuard(tx, channelId, me);
    if ("error" in guard) return guard;
    await tx`UPDATE channels SET meta = ${tx.json(body as any)} WHERE channel_id = ${channelId}`;
    return { ok: true as const };
  });
  if ("error" in result) return c.json(result.error.body, result.error.status as 403 | 404 | 409);
  recordEvent({ type: "channel_meta_update", address: me, channelId, payload: { method: "PUT", size_bytes: serialized.length } });
  publishChannel(channelId, {
    kind: "channel_meta_changed",
    channel_id: channelId,
    by: me,
    method: "PUT",
    size_bytes: serialized.length,
    created_at: new Date().toISOString(),
  });
  // Phase 10 D7 (G #2 fix) — persist meta change so feed renderer's
  // channel_meta_changed branch isn't dead code.
  {
    const meRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${me}`;
    insertChannelEvent({
      channelId,
      kind: "channel_meta_changed",
      actorAddress: me,
      actorUsername: meRow[0]?.username ?? null,
      payload: { method: "PUT", size_bytes: serialized.length },
    });
  }
  return c.json({ ok: true });
});

channelRoutes.patch("/channels/:id/meta", async (c) => {
  let me: string;
  try { me = await withAuth(c); } catch (e) { return authError(c, e); }
  const channelId = c.req.param("id");
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  if (typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "patch body must be a JSON object" }, 400);
  }

  let result: { ok: true } | { error: { body: any; status: number } };
  try {
    result = await sql.begin(async (tx) => {
      const guard = await metaWriteGuard(tx, channelId, me);
      if ("error" in guard) return guard;
      // jsonb shallow merge: existing || patch
      await tx`
        UPDATE channels SET meta = meta || ${tx.json(body as any)}
        WHERE channel_id = ${channelId}
      `;
      // Check merged size — same 16KB cap as PUT to prevent unbounded growth.
      // Throw inside tx to rollback the oversized merge automatically.
      const [row] = await tx<{ size: number }[]>`
        SELECT octet_length(meta::text)::int AS size FROM channels WHERE channel_id = ${channelId}
      `;
      if ((row?.size ?? 0) > 16 * 1024) {
        throw new Error("__META_TOO_LARGE__");
      }
      return { ok: true as const };
    });
  } catch (err) {
    if ((err as Error).message === "__META_TOO_LARGE__") {
      return c.json({ error: "meta too large after merge (max 16KB)" }, 413);
    }
    throw err;
  }
  if ("error" in result) return c.json(result.error.body, result.error.status as 403 | 404 | 409);
  recordEvent({ type: "channel_meta_update", address: me, channelId, payload: { method: "PATCH" } });
  publishChannel(channelId, {
    kind: "channel_meta_changed",
    channel_id: channelId,
    by: me,
    method: "PATCH",
    created_at: new Date().toISOString(),
  });
  // Phase 10 D7 (G #2 fix) — persist meta change.
  {
    const meRow = await sql<{ username: string | null }[]>`SELECT username FROM identities WHERE address = ${me}`;
    insertChannelEvent({
      channelId,
      kind: "channel_meta_changed",
      actorAddress: me,
      actorUsername: meRow[0]?.username ?? null,
      payload: { method: "PATCH" },
    });
  }
  return c.json({ ok: true });
});
