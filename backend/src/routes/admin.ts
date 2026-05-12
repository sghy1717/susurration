// Admin endpoints — analytics on `events` table. Bearer-token gated by
// SUSU_ADMIN_TOKEN env. PII boundary: address_hash is hash(address+salt) so
// admin can JOIN events by user but not reverse to address.
//
// Mount BEFORE the /api/* 404 catch-all in index.ts (otherwise catch-all
// swallows admin routes since they're registered after).

import { Hono } from "hono";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { parseJsonBody, invalidJson } from "../lib/http.ts";
import { isValidSolanaAddress } from "../auth.ts";
import { publishAll, sseStats, type SystemEvent } from "./signals.ts";

export const adminRoutes = new Hono();

function adminGuard(c: Context): { ok: true } | { error: any } {
  if (!config.adminToken) {
    return { error: c.json({ error: "admin_disabled", reason: "SUSU_ADMIN_TOKEN not set" }, 503) };
  }
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  // Constant-time comparison to prevent timing side-channel attacks.
  const expected = Buffer.from(config.adminToken);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { error: c.json({ error: "admin_unauthorized" }, 401) };
  }
  return { ok: true };
}

// GET /admin/events?since=ISO&until=ISO&type=&limit=
// `event_type` accepted as alias for `type` to match the column name and the
// existing `event_type` field in JSON responses (avoids silent param-name drift).
adminRoutes.get("/admin/events", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const since = c.req.query("since");
  const until = c.req.query("until");
  const type = c.req.query("type") ?? c.req.query("event_type");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 1000);

  // Compose conditions safely with postgres.js fragments.
  const rows = await sql<any[]>`
    SELECT event_id, address_hash, event_type, channel_id, payload, created_at
    FROM events
    WHERE 1=1
      ${since ? sql`AND created_at >= ${since}` : sql``}
      ${until ? sql`AND created_at <= ${until}` : sql``}
      ${type  ? sql`AND event_type = ${type}` : sql``}
    ORDER BY created_at DESC LIMIT ${limit}
  `;
  return c.json({ events: rows, count: rows.length, limit });
});

// GET /admin/funnel — register → first push %; basic launch-day metric
// ?exclude_test=false to include test accounts (default: excluded).
// Test accounts: usernames matching 0xwizard0%, s-tester, funneltest,
// hazeprod, ga_%, gb_%, gpub_% (internal test prefixes).
const TEST_USERNAME_PATTERNS = [
  "0xwizard0__",   // 0xwizard001-010
  "s-tester", "funneltest", "hazeprod",
];
async function testAddressHashes(): Promise<string[]> {
  const { hashAddress } = await import("../lib/events.ts");
  const rows = await sql<{ address: string }[]>`
    SELECT address FROM identities
    WHERE username LIKE '0xwizard0%'
       OR username IN ('s-tester', 'funneltest', 'hazeprod')
       OR username LIKE 'ga\\_%' OR username LIKE 'gb\\_%' OR username LIKE 'gpub\\_%'
  `;
  return rows.map(r => hashAddress(r.address));
}

// `window_hours`: optional time window (e.g. 6, 24). Default 0 = cumulative
// (legacy behavior unchanged). Mirrors the param shape used by /admin/errors.
adminRoutes.get("/admin/funnel", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const excludeTest = c.req.query("exclude_test") !== "false";
  const windowHoursRaw = c.req.query("window_hours");
  const windowHours = windowHoursRaw === undefined ? 0 : Number(windowHoursRaw);
  if (!Number.isFinite(windowHours) || windowHours < 0) {
    return c.json({ error: "invalid window_hours" }, 400);
  }
  const excludeHashes = excludeTest ? await testAddressHashes() : [];

  const rows = await sql<{ event_type: string; users: number }[]>`
    SELECT event_type, count(DISTINCT address_hash)::int AS users
    FROM events
    WHERE address_hash IS NOT NULL
      AND event_type IN ('auth_signin', 'register', 'friend_add_accepted', 'channel_create', 'signal_push', 'reaction_push', 'approve_signed')
      ${windowHours > 0 ? sql`AND created_at > now() - ${windowHours + ' hours'}::interval` : sql``}
      ${excludeHashes.length > 0 ? sql`AND address_hash NOT IN ${sql(excludeHashes)}` : sql``}
    GROUP BY event_type
  `;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.event_type] = r.users;
  const auth_signin = counts["auth_signin"] ?? 0;
  return c.json({
    funnel: counts,
    rate_register_over_signin: auth_signin > 0 ? (counts["register"] ?? 0) / auth_signin : null,
    rate_first_push_over_register: (counts["register"] ?? 0) > 0
      ? (counts["signal_push"] ?? 0) / (counts["register"] ?? 1) : null,
    test_excluded: excludeTest,
    test_accounts_filtered: excludeHashes.length,
    window_hours: windowHours > 0 ? windowHours : "cumulative",
  });
});

// GET /admin/retention?cohort_days=7 — D1 / D7 / D30 retention based on signal_push events
adminRoutes.get("/admin/retention", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  // For each user (address_hash), find their first auth_signin date and how many
  // distinct days they pushed signals afterward. Truncated metric — basic but
  // real signal of repeat use.
  const rows = await sql<{ horizon: string; cohort: number; retained: number; rate: number }[]>`
    WITH first_signin AS (
      SELECT address_hash, MIN(date_trunc('day', created_at)) AS d0
      FROM events
      WHERE event_type = 'auth_signin' AND address_hash IS NOT NULL
      GROUP BY address_hash
    ),
    activity AS (
      SELECT e.address_hash, date_trunc('day', e.created_at) AS d, fs.d0
      FROM events e
      JOIN first_signin fs USING (address_hash)
      WHERE e.event_type IN ('signal_push', 'reaction_push')
    )
    SELECT 'D1' AS horizon, COUNT(DISTINCT fs.address_hash)::int AS cohort,
           COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '1 day' AND INTERVAL '2 days')::int AS retained,
           CASE WHEN COUNT(DISTINCT fs.address_hash) > 0
             THEN (COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '1 day' AND INTERVAL '2 days'))::float
                  / COUNT(DISTINCT fs.address_hash) ELSE 0 END AS rate
    FROM first_signin fs LEFT JOIN activity a USING (address_hash)
    UNION ALL
    SELECT 'D7' AS horizon, COUNT(DISTINCT fs.address_hash)::int,
           COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '7 day' AND INTERVAL '8 days')::int,
           CASE WHEN COUNT(DISTINCT fs.address_hash) > 0
             THEN (COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '7 day' AND INTERVAL '8 days'))::float
                  / COUNT(DISTINCT fs.address_hash) ELSE 0 END
    FROM first_signin fs LEFT JOIN activity a USING (address_hash)
    UNION ALL
    SELECT 'D30' AS horizon, COUNT(DISTINCT fs.address_hash)::int,
           COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '30 day' AND INTERVAL '31 days')::int,
           CASE WHEN COUNT(DISTINCT fs.address_hash) > 0
             THEN (COUNT(DISTINCT a.address_hash) FILTER (WHERE a.d - fs.d0 BETWEEN INTERVAL '30 day' AND INTERVAL '31 days'))::float
                  / COUNT(DISTINCT fs.address_hash) ELSE 0 END
    FROM first_signin fs LEFT JOIN activity a USING (address_hash)
  `;
  return c.json({ retention: rows });
});

// GET /admin/errors?since=ISO&window_hours=24
adminRoutes.get("/admin/errors", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const since = c.req.query("since");
  const windowHours = Number(c.req.query("window_hours") ?? 24);
  if (Number.isNaN(windowHours)) return c.json({ error: "invalid window_hours" }, 400);

  // client_error rows store the failure category in payload.error_type
  // (not payload.reason like register_failed / friend_add_failed / charge_failed).
  // Coalesce so the admin endpoint surfaces both shapes.
  const rows = await sql<{ event_type: string; reason: string | null; count: number; latest: string }[]>`
    SELECT event_type,
           COALESCE(payload->>'reason', payload->>'error_type') AS reason,
           count(*)::int AS count,
           max(created_at)::text AS latest
    FROM events
    WHERE event_type IN ('error', 'charge_failed', 'register_failed', 'friend_add_failed', 'client_error')
      AND created_at > ${since ?? sql`now() - ${windowHours + ' hours'}::interval`}
    GROUP BY event_type, COALESCE(payload->>'reason', payload->>'error_type')
    ORDER BY count DESC
  `;
  const total = rows.reduce((s, r) => s + r.count, 0);
  return c.json({ errors: rows, total, window_hours: windowHours });
});

// GET /admin/user-journey?address_hash=&username=
adminRoutes.get("/admin/user-journey", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  let addressHash = c.req.query("address_hash");
  const username = c.req.query("username");

  if (!addressHash && username) {
    const { hashAddress } = await import("../lib/events.ts");
    const userRow = await sql<{ address: string }[]>`
      SELECT address FROM identities WHERE username = ${username}
    `;
    if (!userRow[0]) return c.json({ error: "user_not_found" }, 404);
    addressHash = hashAddress(userRow[0].address);
  }
  if (!addressHash) return c.json({ error: "provide address_hash or username" }, 400);

  const events = await sql<any[]>`
    SELECT event_id, event_type, channel_id, payload, created_at
    FROM events
    WHERE address_hash = ${addressHash}
    ORDER BY created_at ASC LIMIT 500
  `;
  const stages = events.map(e => e.event_type);
  const uniqueStages = [...new Set(stages)];
  return c.json({ address_hash: addressHash, events, stages_reached: uniqueStages, total: events.length });
});

// GET /admin/users — list registered users with their funnel progress
adminRoutes.get("/admin/users", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const since = c.req.query("since");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);

  const rows = await sql<any[]>`
    SELECT i.username, i.auto_accept_friends, i.created_at, i.last_active_at,
           i.webhook_url IS NOT NULL AS has_webhook,
           (SELECT count(*)::int FROM friend_links fl WHERE fl.a = i.address OR fl.b = i.address) AS friend_count,
           (SELECT count(*)::int FROM usage_log ul WHERE ul.address = i.address) AS push_count
    FROM identities i
    WHERE i.username IS NOT NULL
      ${since ? sql`AND i.created_at >= ${since}` : sql``}
    ORDER BY i.created_at DESC
    LIMIT ${limit}
  `;
  return c.json({ users: rows, count: rows.length });
});

// ─── Handle reclaim (180-day inactivity) ──────────────────────────────
// GET /admin/stale-handles?days=180 — list handles inactive for N+ days
adminRoutes.get("/admin/stale-handles", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const days = Math.max(Number(c.req.query("days") ?? 180), 1);
  if (Number.isNaN(days)) return c.json({ error: "invalid days" }, 400);

  const rows = await sql<{ username: string; last_active_at: string; created_at: string; friend_count: number; push_count: number }[]>`
    SELECT i.username, i.last_active_at::text, i.created_at::text,
           (SELECT count(*)::int FROM friend_links fl WHERE fl.a = i.address OR fl.b = i.address) AS friend_count,
           (SELECT count(*)::int FROM usage_log ul WHERE ul.address = i.address) AS push_count
    FROM identities i
    WHERE i.username IS NOT NULL
      AND i.last_active_at < now() - ${days + ' days'}::interval
    ORDER BY i.last_active_at ASC
  `;
  return c.json({ stale: rows, count: rows.length, threshold_days: days });
});

// POST /admin/reclaim-handle  body: {username}
// Clears the username from the identity row, making it available again.
adminRoutes.post("/admin/reclaim-handle", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const username = String(body?.username ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!username) return c.json({ error: "username required" }, 400);

  const rows = await sql<{ address: string; last_active_at: Date }[]>`
    SELECT address, last_active_at FROM identities WHERE username = ${username}
  `;
  if (!rows[0]) return c.json({ error: "username_not_found" }, 404);

  await sql`UPDATE identities SET username = NULL WHERE username = ${username}`;
  return c.json({ ok: true, reclaimed: username, previous_owner_last_active: rows[0].last_active_at });
});

// ─── Reserved-username management ───────────────────────────────────────
// (Mirrors migration 005's table.) Categories enforced server-side:
//   - system / obscenity → hard-blocked, never grantable
//   - rare → grantable to a specific address; recipient registers normally
// All endpoints SUSU_ADMIN_TOKEN-gated via adminGuard.

const RESERVED_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESERVED_CATEGORIES = new Set(["system", "rare", "obscenity"] as const);
type ReservedCategory = "system" | "rare" | "obscenity";

// POST /admin/usernames  body: {username, category, reason?}
adminRoutes.post("/admin/usernames", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;
  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);

  const username = String(body?.username ?? "").trim().toLowerCase().replace(/^@/, "");
  const category = String(body?.category ?? "");
  const reason = body?.reason ? String(body.reason).slice(0, 280) : null;

  if (!RESERVED_NAME_RE.test(username)) {
    return c.json({ error: "invalid_username", message: "1-40 chars, lowercase a-z 0-9 _ -" }, 400);
  }
  if (!RESERVED_CATEGORIES.has(category as ReservedCategory)) {
    return c.json({ error: "invalid_category", allowed: [...RESERVED_CATEGORIES] }, 400);
  }

  try {
    const [row] = await sql<{ username: string; category: string; reason: string | null; created_at: Date }[]>`
      INSERT INTO reserved_usernames(username, category, reason)
      VALUES (${username}, ${category}, ${reason})
      RETURNING username, category, reason, created_at
    `;
    return c.json({ ok: true, reserved: row }, 201);
  } catch (e: any) {
    if (e.code === "23505") {
      return c.json({ error: "already_reserved", username }, 409);
    }
    throw e;
  }
});

// GET /admin/usernames?category=&granted=true|false
adminRoutes.get("/admin/usernames", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const category = c.req.query("category");
  const granted = c.req.query("granted");
  if (category && !RESERVED_CATEGORIES.has(category as ReservedCategory)) {
    return c.json({ error: "invalid_category", allowed: [...RESERVED_CATEGORIES] }, 400);
  }

  const rows = await sql<any[]>`
    SELECT username, category, reason, granted_to, granted_at, created_at
    FROM reserved_usernames
    WHERE 1=1
      ${category ? sql`AND category = ${category}` : sql``}
      ${granted === "true"  ? sql`AND granted_to IS NOT NULL` : sql``}
      ${granted === "false" ? sql`AND granted_to IS NULL` : sql``}
    ORDER BY category ASC, username ASC
  `;
  return c.json({ reserved: rows, count: rows.length });
});

// DELETE /admin/usernames/:username  — release back to the open pool
adminRoutes.delete("/admin/usernames/:username", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const username = (c.req.param("username") ?? "").toLowerCase().replace(/^@/, "");
  if (!RESERVED_NAME_RE.test(username)) {
    return c.json({ error: "invalid_username" }, 400);
  }

  const deleted = await sql<{ username: string }[]>`
    DELETE FROM reserved_usernames WHERE username = ${username} RETURNING username
  `;
  if (!deleted[0]) return c.json({ error: "not_reserved", username }, 404);
  return c.json({ ok: true, released: username });
});

// POST /admin/usernames/:username/grant  body: {address}
// 2026-04-30: changed from "whitelist + recipient registers" to "directly
// lock username on the recipient's identity row". Reasons:
//   1. Recipient no longer needs to call `susu register` for granted names —
//      after grant they see @<name> on `whoami` immediately. Cleaner UX.
//   2. CLI client-side check stays at {5,20} (matches DOC self-serve rule);
//      3-4 char rare names go through this admin path only, never through
//      the user-facing `register` flow. Three layers (DOC / CLI / server)
//      no longer disagree on the floor.
// system / obscenity categories REJECT — only `rare` may be granted.
adminRoutes.post("/admin/usernames/:username/grant", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const username = (c.req.param("username") ?? "").toLowerCase().replace(/^@/, "");
  if (!RESERVED_NAME_RE.test(username)) {
    return c.json({ error: "invalid_username" }, 400);
  }

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const address = String(body?.address ?? "");
  if (!isValidSolanaAddress(address)) {
    return c.json({ error: "invalid_address" }, 400);
  }

  // Pull current reserved row + ensure category is `rare`.
  const [row] = await sql<{ category: string; granted_to: string | null }[]>`
    SELECT category, granted_to FROM reserved_usernames WHERE username = ${username}
  `;
  if (!row) {
    return c.json({ error: "not_reserved", message: "add to reserved list first via POST /admin/usernames" }, 404);
  }
  if (row.category !== "rare") {
    return c.json({
      error: "category_not_grantable",
      category: row.category,
      message: "only 'rare' names can be granted; system/obscenity are permanently locked",
    }, 409);
  }

  // Atomic: ensure the recipient identity exists, refuse if they already
  // locked another handle (usernames are immutable per D13), then lock
  // the granted username on their identity row + mark the reserved entry
  // as granted-to. Concurrent UNIQUE collision (someone else grabbed the
  // name in between) bubbles up as 409.
  try {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO identities(address) VALUES (${address}) ON CONFLICT (address) DO NOTHING`;
      const cur = await tx<{ username: string | null }[]>`
        SELECT username FROM identities WHERE address = ${address}
      `;
      if (cur[0]?.username && cur[0].username !== username) {
        throw Object.assign(new Error("recipient_already_locked"), {
          status: 409,
          detail: { current: cur[0].username },
        });
      }
      await tx`UPDATE identities SET username = ${username} WHERE address = ${address}`;
      await tx`
        UPDATE reserved_usernames
           SET granted_to = ${address}, granted_at = NOW()
         WHERE username = ${username}
      `;
    });
  } catch (e: any) {
    if (e?.status === 409) {
      return c.json({
        error: "recipient_already_locked",
        message: "recipient already has a different handle and usernames are immutable",
        current: e.detail?.current,
      }, 409);
    }
    if (e?.code === "23505") {
      return c.json({ error: "username_taken", message: "concurrent registration grabbed this name first" }, 409);
    }
    throw e;
  }
  return c.json({ ok: true, username, locked_to: address });
});

// ─── Admin set auto_accept for a user ─────────────────────────────────────
// POST /admin/auto-accept  body: {handle: "@name", value: boolean}
// Lets admin toggle auto_accept_friends for any user (e.g. demo accounts).
adminRoutes.post("/admin/auto-accept", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const handle = String(body?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return c.json({ error: "handle required" }, 400);
  const value = Boolean(body?.value ?? true);

  const [row] = await sql<{ address: string }[]>`
    SELECT address FROM identities WHERE handle = ${handle} OR username = ${handle}
  `;
  if (!row) return c.json({ error: "user_not_found", handle }, 404);

  await sql`UPDATE identities SET auto_accept_friends = ${value} WHERE address = ${row.address}`;
  return c.json({ ok: true, handle, auto_accept_friends: value });
});

// ─── System broadcast ───────────────────────────────────────────────────
// POST /admin/broadcast  body: {message, level?}
// Pushes a system event to ALL connected SSE subscribers.
adminRoutes.post("/admin/broadcast", async (c) => {
  const g = adminGuard(c);
  if ("error" in g) return g.error;

  const body = await parseJsonBody(c);
  if (body === null) return invalidJson(c);
  const message = String(body?.message ?? "").trim();
  if (!message) return c.json({ error: "message required" }, 400);
  const level = (body?.level === "warn" || body?.level === "urgent") ? body.level : "info";

  const evt: SystemEvent = {
    kind: "system",
    message,
    level: level as "info" | "warn" | "urgent",
    created_at: new Date().toISOString(),
  };

  const stats = sseStats();
  publishAll(evt);
  return c.json({ ok: true, delivered_to_subscribers: stats.subscribers, level });
});
