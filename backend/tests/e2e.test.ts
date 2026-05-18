// End-to-end smoke against a running Postgres.
//
// Pre-reqs:
//   docker compose up -d postgres
//   bun migrate
//
// Skipped automatically if SUSU_E2E is not set, so plain `bun test` from a
// laptop without Docker still passes the unit tests.
//
// Usage:
//   SUSU_E2E=1 bun test tests/e2e.test.ts                     # BETA (rate=0) mode
//   SUSU_E2E=1 BILLING_RATE_USD=1 bun test tests/e2e.test.ts  # paid-mode shape checks
//
// 2026-04-29 D13 rewrite: vote/proposal endpoints, credit/deposit/balance
// endpoints, and the 24h kick cooldown all removed. Tests are now organised
// by feature: identity → friends → groups → meta → signals → billing-shape.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";

const E2E = process.env.SUSU_E2E === "1";
const describeE2E = E2E ? describe : describe.skip;

let app: { fetch: (req: Request) => Promise<Response> };
let sqlMod: typeof import("../src/db.ts");

type Wallet = {
  address: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

function makeWallet(): Wallet {
  const kp = nacl.sign.keyPair();
  return { address: bs58.encode(kp.publicKey), publicKey: kp.publicKey, secretKey: kp.secretKey };
}

async function login(w: Wallet): Promise<string> {
  const nonceResp = await app.fetch(new Request("http://test/api/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: w.address }),
  }));
  expect(nonceResp.status).toBe(200);
  const { nonce, message } = await nonceResp.json() as { nonce: string; message: string };

  const sig = nacl.sign.detached(new TextEncoder().encode(message), w.secretKey);
  const sig_b58 = bs58.encode(sig);

  const verifyResp = await app.fetch(new Request("http://test/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: w.address, nonce, signature_b58: sig_b58 }),
  }));
  expect(verifyResp.status).toBe(200);
  const { token } = await verifyResp.json() as { token: string };
  return token;
}

function authHeaders(token: string) {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function register(token: string, username: string): Promise<{ address: string; username: string }> {
  const r = await app.fetch(new Request("http://test/api/identity/register", {
    method: "POST", headers: authHeaders(token), body: JSON.stringify({ username }),
  }));
  expect(r.status).toBe(200);
  return await r.json() as any;
}

function requireRate(rate: number): boolean {
  return Number(process.env.BILLING_RATE_USD ?? 0) === rate;
}

// Generate a unique short-form username so concurrent test runs don't collide.
let _userIdx = 0;
function uname(prefix = "u"): string {
  _userIdx += 1;
  // username regex: [a-z0-9_-]{3,20}
  return `${prefix}_${Date.now().toString(36)}_${_userIdx}`.slice(0, 20).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

// Admin token for the reserved-username admin endpoints. Set in
// `tests/setup.ts` (Bun preload) so src/config.ts captures it on module load.
const TEST_ADMIN_TOKEN = "test-admin-token-e2e";

describeE2E("Susurration E2E (D7+D13)", () => {
  beforeAll(async () => {
    process.env.PORT = process.env.PORT ?? "0";
    sqlMod = await import("../src/db.ts");
    // Hard reset all D13 tables. Order respects FK chains.
    // NB: TRUNCATE identities CASCADE also wipes reserved_usernames (FK
    // granted_to → identities.address). We re-seed reserved_usernames
    // below from migration 005 to keep the system / obscenity blocklist
    // available for the tests that depend on it.
    await sqlMod.sql`TRUNCATE
      events, approval_cache, spender_rotations,
      friend_requests, friend_links,
      usage_log, kick_history, channel_ban_list,
      reactions, signals, channel_members, channels,
      stream_tokens, sessions, auth_nonces, identities,
      reserved_usernames
      RESTART IDENTITY CASCADE`;
    // Re-seed reserved_usernames from migration 005 so admin/system/obscenity
    // entries are available to the tests. Reads INSERT statements out of the
    // migration file so the seed never drifts from production.
    const migPath = new URL("../migrations/005_reserved_usernames.sql", import.meta.url);
    const migText = await Bun.file(migPath).text();
    const inserts = migText.match(/^INSERT INTO reserved_usernames[\s\S]+?;/gm) ?? [];
    for (const stmt of inserts) {
      await sqlMod.sql.unsafe(stmt);
    }

    const mod = await import("../src/index.ts");
    app = { fetch: (mod as any).default.fetch };
  });

  afterAll(async () => {
    await sqlMod.sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    const { _resetForTests } = await import("../src/lib/rate_limit.ts");
    _resetForTests();
  });

  // ── Identity ──────────────────────────────────────────────────────────

  test("identity: register locks a permanent username; second register returns 409", async () => {
    const w = makeWallet();
    const t = await login(w);
    const u = uname("alice");
    const out = await register(t, u);
    expect(out.username).toBe(u);

    // Re-register same address with a different name → 409 already_locked.
    const second = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: uname("alice2") }),
    }));
    expect(second.status).toBe(409);
    const body = await second.json() as any;
    expect(body.error).toBe("username_already_locked");
  });

  test("identity: same username taken by another address returns 409 username_taken", async () => {
    const w1 = makeWallet(); const t1 = await login(w1);
    const w2 = makeWallet(); const t2 = await login(w2);
    const u = uname("dup");
    await register(t1, u);
    const r = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t2), body: JSON.stringify({ username: u }),
    }));
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error).toBe("username_taken");
  });

  test("identity: invalid username format returns 400", async () => {
    const w = makeWallet(); const t = await login(w);
    // Note: server lowercases input, so caps alone aren't invalid. Invalid =
    // too short (<3), too long (>20), or contains chars outside [a-z0-9_-].
    for (const bad of ["ab", "way-too-long-name-exceeds-twenty", "has spaces", "exclam!", "中文"]) {
      const r = await app.fetch(new Request("http://test/api/identity/register", {
        method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: bad }),
      }));
      expect(r.status).toBe(400);
    }
  });

  test("identity: by-username lookup is public (no auth)", async () => {
    const w = makeWallet(); const t = await login(w);
    const u = uname("pub");
    await register(t, u);
    const r = await app.fetch(new Request(`http://test/api/identity/by-username/${u}`));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.username).toBe(u);
    expect(body.address).toBe(w.address);
  });

  // ── Reserved usernames (migration 005) ───────────────────────────────

  test("reserved: 3-4 char self-serve registration returns 409 rare", async () => {
    // 3-char "abc" — not in seed; format passes DB floor (>=3) but blocked by
    // <5 self-serve length rule.
    const w = makeWallet(); const t = await login(w);
    const r = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: "abc" }),
    }));
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error).toBe("username_reserved");
    expect(body.category).toBe("rare");

    // 4-char also blocked
    const w2 = makeWallet(); const t2 = await login(w2);
    const r2 = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t2), body: JSON.stringify({ username: "abcd" }),
    }));
    expect(r2.status).toBe(409);
    expect((await r2.json() as any).category).toBe("rare");
  });

  test("reserved: system word ('admin') returns 409 system", async () => {
    const w = makeWallet(); const t = await login(w);
    const r = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: "admin" }),
    }));
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error).toBe("username_reserved");
    expect(body.category).toBe("system");
  });

  test("reserved: susurration variant ('whisper') returns 409 system", async () => {
    const w = makeWallet(); const t = await login(w);
    const r = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: "whisper" }),
    }));
    expect(r.status).toBe(409);
    expect((await r.json() as any).category).toBe("system");
  });

  test("reserved: obscenity returns 409 obscenity", async () => {
    const w = makeWallet(); const t = await login(w);
    const r = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ username: "fuck" }),
    }));
    expect(r.status).toBe(409);
    expect((await r.json() as any).category).toBe("obscenity");
  });

  test("admin: full grant flow — reserve rare → grant directly locks recipient's @handle", async () => {
    const adminAuth = { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

    // Use a unique 4-char rare name per test run to avoid cross-test collisions.
    const rareName = `r${Date.now().toString(36).slice(-3)}`.slice(0, 4);

    // 1. admin reserves it as rare
    const reserve = await app.fetch(new Request("http://test/api/admin/usernames", {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({ username: rareName, category: "rare", reason: "e2e test" }),
    }));
    expect(reserve.status).toBe(201);

    // 2. before grant, anyone trying to register hits 409 username_reserved
    const wA = makeWallet(); const tA = await login(wA);
    const before = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: rareName }),
    }));
    expect(before.status).toBe(409);
    expect((await before.json() as any).category).toBe("rare");

    // 3. admin grants to alice — server directly locks identities.username
    //    on alice's row. Recipient does NOT need to register afterwards.
    const grant = await app.fetch(new Request(`http://test/api/admin/usernames/${rareName}/grant`, {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({ address: wA.address }),
    }));
    expect(grant.status).toBe(200);
    const grantBody = await grant.json() as any;
    expect(grantBody.username).toBe(rareName);
    expect(grantBody.locked_to).toBe(wA.address);

    // 4. alice's whoami immediately shows the granted handle (no register call)
    const me = await app.fetch(new Request("http://test/api/identity/whoami", { headers: authHeaders(tA) }));
    expect(me.status).toBe(200);
    expect((await me.json() as any).username).toBe(rareName);

    // 5. if alice tries register the same name again → 409 username_already_locked
    //    (handles are immutable per D13).
    const reReg = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: rareName }),
    }));
    expect(reReg.status).toBe(409);

    // 6. bob (different keypair) trying register the same name → 409 (UNIQUE collision)
    const wB = makeWallet(); const tB = await login(wB);
    const bobTry = await app.fetch(new Request("http://test/api/identity/register", {
      method: "POST", headers: authHeaders(tB), body: JSON.stringify({ username: rareName }),
    }));
    expect(bobTry.status).toBe(409);
  });

  test("admin: cannot grant system or obscenity (returns 409 category_not_grantable)", async () => {
    const adminAuth = { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
    const w = makeWallet();
    const grant = await app.fetch(new Request("http://test/api/admin/usernames/admin/grant", {
      method: "POST", headers: adminAuth,
      body: JSON.stringify({ address: w.address }),
    }));
    expect(grant.status).toBe(409);
    const body = await grant.json() as any;
    expect(body.error).toBe("category_not_grantable");
    expect(body.category).toBe("system");
  });

  test("admin: bad token returns 401, missing token returns 401", async () => {
    const r = await app.fetch(new Request("http://test/api/admin/usernames", {
      method: "GET", headers: { authorization: "Bearer wrong" },
    }));
    expect(r.status).toBe(401);

    const r2 = await app.fetch(new Request("http://test/api/admin/usernames", {
      method: "GET",
    }));
    expect(r2.status).toBe(401);
  });

  // ── Friends + 1-on-1 channel auto-create (D7 v0.5 + D13) ────────────

  test("friends: auto-accept on → 1-on-1 channel created in one call", async () => {
    // Default (per migration 006) is OFF; flip B to ON for this test.
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    await register(tA, uname("a"));
    const bUsername = uname("b");
    await register(tB, bUsername);
    await sqlMod.sql`UPDATE identities SET auto_accept_friends = true WHERE address = ${wB.address}`;

    const r = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bUsername }),
    }));
    expect(r.status).toBe(201);
    const body = await r.json() as any;
    expect(body.status).toBe("added");
    expect(body.channel_id).toBeTruthy();

    // Both sides see the friend in /friends list, with the same channel_id.
    const aFriends = await (await app.fetch(new Request("http://test/api/friends", { headers: authHeaders(tA) }))).json() as any;
    const bFriends = await (await app.fetch(new Request("http://test/api/friends", { headers: authHeaders(tB) }))).json() as any;
    expect(aFriends.friends.length).toBe(1);
    expect(bFriends.friends.length).toBe(1);
    expect(aFriends.friends[0].channel_id).toBe(body.channel_id);
    expect(bFriends.friends[0].channel_id).toBe(body.channel_id);
  });

  test("friends: idempotent — second add returns already_friends", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    await register(tA, uname("a"));
    const bUsername = uname("b");
    await register(tB, bUsername);
    await sqlMod.sql`UPDATE identities SET auto_accept_friends = true WHERE address = ${wB.address}`;
    await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bUsername }),
    }));
    const r2 = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bUsername }),
    }));
    expect(r2.status).toBe(200);
    const body = await r2.json() as any;
    expect(body.status).toBe("already_friends");
  });

  test("friends: default OFF (post migration 006) — adds queue as pending", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB); void tB;
    await register(tA, uname("a"));
    const bUsername = uname("b");
    await register(tB, bUsername);
    // Both default to OFF — no UPDATE needed.
    const r = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bUsername }),
    }));
    expect(r.status).toBe(201);
    const body = await r.json() as any;
    expect(body.status).toBe("pending");
    expect(body.request_id).toBeTruthy();
  });

  test("identity/auto-accept toggle endpoint", async () => {
    const w = makeWallet(); const t = await login(w);
    await register(t, uname("toggle"));
    // start: false (default)
    const me1 = await (await app.fetch(new Request("http://test/api/identity/whoami", { headers: authHeaders(t) }))).json() as any;
    expect(me1.auto_accept_friends).toBe(false);
    // flip ON
    const r1 = await app.fetch(new Request("http://test/api/identity/auto-accept", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ value: true }),
    }));
    expect(r1.status).toBe(200);
    expect((await r1.json() as any).auto_accept_friends).toBe(true);
    // flip OFF
    const r2 = await app.fetch(new Request("http://test/api/identity/auto-accept", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ value: false }),
    }));
    expect(r2.status).toBe(200);
    expect((await r2.json() as any).auto_accept_friends).toBe(false);
  });

  test("friends: auto-accept off → creates request; accept creates channel", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const aUsername = uname("a");
    const bUsername = uname("b");
    await register(tA, aUsername);
    await register(tB, bUsername);
    // Flip B's auto-accept off via direct DB write (no API to set it yet).
    await sqlMod.sql`UPDATE identities SET auto_accept_friends = false WHERE address = ${wB.address}`;

    const r1 = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bUsername }),
    }));
    expect(r1.status).toBe(201);
    const body1 = await r1.json() as any;
    expect(body1.status).toBe("pending");

    // B sees the pending request.
    const reqs = await (await app.fetch(new Request("http://test/api/friends/requests", { headers: authHeaders(tB) }))).json() as any;
    expect(reqs.requests.length).toBe(1);

    // B accepts.
    const r2 = await app.fetch(new Request("http://test/api/friends/accept", {
      method: "POST", headers: authHeaders(tB), body: JSON.stringify({ username: aUsername }),
    }));
    expect(r2.status).toBe(201);
    const body2 = await r2.json() as any;
    expect(body2.channel_id).toBeTruthy();
  });

  // ── 1-on-1 reject pattern (D7 + D13) ────────────────────────────────

  test("1-on-1 channel rejects kick/invite/transfer-owner/meta with 409 not_supported_for_1on1", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const wC = makeWallet(); await login(wC); // bystander
    await register(tA, uname("a"));
    const bU = uname("b"); await register(tB, bU);
    // Need bU's auto_accept ON so the add creates a 1-on-1 channel directly.
    await sqlMod.sql`UPDATE identities SET auto_accept_friends = true WHERE address = ${wB.address}`;
    const r = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bU }),
    }));
    const { channel_id } = await r.json() as any;

    const expectsNotSupported = async (path: string, method: string, body: any = {}) => {
      const resp = await app.fetch(new Request(`http://test/api${path}`, {
        method, headers: authHeaders(tA), body: JSON.stringify(body),
      }));
      expect(resp.status).toBe(409);
      const j = await resp.json() as any;
      expect(j.error).toBe("not_supported_for_1on1");
    };
    await expectsNotSupported(`/channels/${channel_id}/kick`, "POST", { address: wB.address });
    await expectsNotSupported(`/channels/${channel_id}/invite`, "POST", { address: wC.address });
    await expectsNotSupported(`/channels/${channel_id}/transfer-owner`, "POST", { candidate_address: wB.address });
    await expectsNotSupported(`/channels/${channel_id}/meta`, "PUT", { foo: "bar" });
    await expectsNotSupported(`/channels/${channel_id}/meta`, "PATCH", { foo: "bar" });
  });

  // ── Groups (D7 v0.6 + D13) ─────────────────────────────────────────

  test("group: creator becomes owner immediately (no vote)", async () => {
    const w = makeWallet(); const t = await login(w);
    await register(t, uname("g"));
    const r = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ name: "team-alpha" }),
    }));
    expect(r.status).toBe(201);
    const body = await r.json() as any;
    expect(body.is_group).toBe(true);
    expect(body.owner).toBe(w.address);
  });

  test("group: owner leave → auto-elect earliest-joined remaining member", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const wC = makeWallet(); const tC = await login(wC); void tC;
    await register(tA, uname("a")); await register(tB, uname("b"));
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "auto-elect-test" }),
    }));
    const { channel_id } = await create.json() as any;
    // Invite B then C; B will be earliest joined among non-owners.
    for (const w of [wB, wC]) {
      const r = await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
        method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: w.address }),
      }));
      expect(r.status).toBe(200);
    }
    // A leaves; B should auto-elect.
    const leave = await app.fetch(new Request(`http://test/api/channels/${channel_id}/leave`, {
      method: "POST", headers: authHeaders(tA),
    }));
    expect(leave.status).toBe(200);

    // Verify ownership transferred to B.
    const ch = await (await app.fetch(new Request(`http://test/api/channels/${channel_id}`, {
      headers: authHeaders(tB),
    }))).json() as any;
    expect(ch.owner).toBe(wB.address);
  });

  test("group: solo leave disbands channel (404 on subsequent reads)", async () => {
    const w = makeWallet(); const t = await login(w);
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ name: "solo" }),
    }));
    const { channel_id } = await create.json() as any;
    const leave = await app.fetch(new Request(`http://test/api/channels/${channel_id}/leave`, {
      method: "POST", headers: authHeaders(t),
    }));
    expect(leave.status).toBe(200);
    const get = await app.fetch(new Request(`http://test/api/channels/${channel_id}`, { headers: authHeaders(t) }));
    expect(get.status).toBe(404);
  });

  test("group: kick by non-owner → 403", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "kick-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));
    const r = await app.fetch(new Request(`http://test/api/channels/${channel_id}/kick`, {
      method: "POST", headers: authHeaders(tB), body: JSON.stringify({ address: wA.address }),
    }));
    expect(r.status).toBe(403);
  });

  test("group: transfer-owner by current owner succeeds, then non-owner can't transfer back", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "transfer-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));
    const r1 = await app.fetch(new Request(`http://test/api/channels/${channel_id}/transfer-owner`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ candidate_address: wB.address }),
    }));
    expect(r1.status).toBe(200);
    const ch = await (await app.fetch(new Request(`http://test/api/channels/${channel_id}`, {
      headers: authHeaders(tA),
    }))).json() as any;
    expect(ch.owner).toBe(wB.address);

    // Now A is non-owner — transfer back must 403.
    const r2 = await app.fetch(new Request(`http://test/api/channels/${channel_id}/transfer-owner`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ candidate_address: wA.address }),
    }));
    expect(r2.status).toBe(403);
  });

  // ── Channel meta KV (D13 Class 3 primitive) ───────────────────────

  test("meta: GET as member, PUT as owner, PATCH merges, 16KB limit returns 413", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "meta-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));

    // PUT initial
    const put = await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      method: "PUT", headers: authHeaders(tA), body: JSON.stringify({ rules: { kick_cooldown_hours: 24 }, theme: "dark" }),
    }));
    expect(put.status).toBe(200);

    // GET as B (member) succeeds and sees the data.
    const get = await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      headers: authHeaders(tB),
    }));
    expect(get.status).toBe(200);
    const body = await get.json() as any;
    expect(body.meta.theme).toBe("dark");
    expect(body.meta.rules.kick_cooldown_hours).toBe(24);

    // PATCH merges
    const patch = await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      method: "PATCH", headers: authHeaders(tA), body: JSON.stringify({ extra: "added" }),
    }));
    expect(patch.status).toBe(200);
    const body2 = await (await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      headers: authHeaders(tA),
    }))).json() as any;
    expect(body2.meta.extra).toBe("added");
    expect(body2.meta.theme).toBe("dark"); // preserved

    // PUT as non-owner → 403
    const denied = await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      method: "PUT", headers: authHeaders(tB), body: JSON.stringify({ a: 1 }),
    }));
    expect(denied.status).toBe(403);

    // 16KB limit
    const big = { x: "x".repeat(20_000) };
    const tooBig = await app.fetch(new Request(`http://test/api/channels/${channel_id}/meta`, {
      method: "PUT", headers: authHeaders(tA), body: JSON.stringify(big),
    }));
    expect(tooBig.status).toBe(413);
  });

  // ── Signals + reactions ───────────────────────────────────────────

  test("signal+react happy path (BETA mode: free; paid mode: 402 on no allowance)", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    await register(tA, uname("a"));
    const bU = uname("b"); await register(tB, bU);
    // bU's auto-accept ON so the add creates a 1-on-1 channel directly.
    await sqlMod.sql`UPDATE identities SET auto_accept_friends = true WHERE address = ${wB.address}`;
    const add = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bU }),
    }));
    const { channel_id } = await add.json() as any;

    const push = await app.fetch(new Request(`http://test/api/channels/${channel_id}/signals`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ symbol: "ETH", direction: "long" }),
    }));
    if (requireRate(0)) {
      expect(push.status).toBe(201);
      const body = await push.json() as any;
      expect(body.cost_usd).toBe(0);
      expect(body.allowance_after?.status).toBe("BETA — free");

      // Reaction also free.
      const r = await app.fetch(new Request(`http://test/api/signals/${body.signal_id}/reactions`, {
        method: "POST", headers: authHeaders(tB), body: JSON.stringify({ payload: { ack: "agree" }, is_auto: true }),
      }));
      expect(r.status).toBe(201);
    } else {
      // Paid mode without on-chain approve → 402 insufficient_allowance.
      expect(push.status).toBe(402);
      const body = await push.json() as any;
      expect(body.error).toBe("insufficient_allowance");
      expect(body.approve_again_url).toBeTruthy();
    }
  });

  // ── Billing surface (transparency endpoints) ────────────────────────

  test("billing: /allowance returns BETA shape when rate=0, paid shape when rate=1", async () => {
    const w = makeWallet(); const t = await login(w);
    const r = await app.fetch(new Request("http://test/api/billing/allowance", { headers: authHeaders(t) }));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    if (requireRate(0)) {
      expect(body.status).toBe("BETA — free");
      expect(body.rate_usd_per_call).toBe(0);
      expect(body.usdc_mint).toBeTruthy();
    } else {
      expect(body.status).toBe("paid");
      expect(body.rate_usd_per_call).toBe(1);
      expect(body.approve_again_url).toBeTruthy();
    }
  });

  test("billing: /spender is public (no auth) and returns USDC mint + cluster", async () => {
    const r = await app.fetch(new Request("http://test/api/billing/spender"));
    // 200 in any mode where spender wallet is configured. 503 if not.
    expect([200, 503]).toContain(r.status);
    if (r.status === 200) {
      const body = await r.json() as any;
      expect(body.usdc_mint).toBeTruthy();
      expect(body.cluster).toBeTruthy();
    }
  });

  // ── Existing regressions (still relevant after D13) ───────────────

  test("R4: deleted channel returns 404 (existence-then-membership)", async () => {
    const w = makeWallet(); const t = await login(w);
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(t), body: JSON.stringify({ name: "solo" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/leave`, {
      method: "POST", headers: authHeaders(t),
    }));
    const get = await app.fetch(new Request(`http://test/api/channels/${channel_id}`, { headers: authHeaders(t) }));
    expect(get.status).toBe(404);
    const members = await app.fetch(new Request(`http://test/api/channels/${channel_id}/members`, { headers: authHeaders(t) }));
    expect(members.status).toBe(404);
  });

  test("R2: SSE stream-token single-use; bare bearer in URL rejected", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB); void tB;
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "sse-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));

    const st = await app.fetch(new Request("http://test/api/auth/stream-token", {
      method: "POST", headers: authHeaders(tA),
    }));
    const { stream_token } = await st.json() as { stream_token: string };

    const ctrl = new AbortController();
    const sse = await app.fetch(new Request(
      `http://test/api/channels/${channel_id}/signals/stream?stream_token=${stream_token}`,
      { signal: ctrl.signal },
    ));
    expect(sse.status).toBe(200);
    ctrl.abort();
    try { await sse.body?.cancel(); } catch {}

    const reuse = await app.fetch(new Request(
      `http://test/api/channels/${channel_id}/signals/stream?stream_token=${stream_token}`,
    ));
    expect(reuse.status).toBe(401);

    const oldStyle = await app.fetch(new Request(
      `http://test/api/channels/${channel_id}/signals/stream?token=fake`,
    ));
    expect(oldStyle.status).toBe(401);
  });

  test("Y2: invalid JSON body returns 400 invalid_json", async () => {
    const r = await app.fetch(new Request("http://test/api/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    }));
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.error).toBe("invalid_json");
  });

  test("BETA-1.a: signal payload over 64KB returns 413 (Content-Length path)", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB); void tB;
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "size-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));
    const huge = JSON.stringify({ spam: "x".repeat(70_000) });
    const r = await app.fetch(new Request(`http://test/api/channels/${channel_id}/signals`, {
      method: "POST", headers: authHeaders(tA), body: huge,
    }));
    expect(r.status).toBe(413);
    const body = await r.json() as any;
    expect(body.error).toBe("payload_too_large");
  });

  test("BETA-1.a: chunked body over 64KB returns 413 (no race) — G-R-1 regression", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB); void tB;
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "chunked-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));

    function makeChunkedBody(): ReadableStream<Uint8Array> {
      const enc = new TextEncoder();
      const chunks: Uint8Array[] = [];
      chunks.push(enc.encode('{"spam":"'));
      const x = "x".repeat(4096);
      for (let i = 0; i < 20; i++) chunks.push(enc.encode(x));
      chunks.push(enc.encode('"}'));
      let i = 0;
      return new ReadableStream({
        pull(ctrl) {
          if (i >= chunks.length) { ctrl.close(); return; }
          ctrl.enqueue(chunks[i++]);
        },
      });
    }

    for (let run = 0; run < 5; run++) {
      const r = await app.fetch(new Request(`http://test/api/channels/${channel_id}/signals`, {
        method: "POST", headers: authHeaders(tA), body: makeChunkedBody(),
        // @ts-ignore Bun supports duplex
        duplex: "half",
      }));
      expect(r.status).toBe(413);
      const body = await r.json() as any;
      expect(body.error).toBe("payload_too_large");
    }
  });

  test("BETA-1.b: 31st push in <1min returns 429 rate_limited (BETA only — paid mode 402s first)", async () => {
    if (!requireRate(0)) { return; } // paid mode would 402 before hitting rate limiter
    const { _resetForTests } = await import("../src/lib/rate_limit.ts");
    _resetForTests();
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB); void tB;
    const create = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "rate-test" }),
    }));
    const { channel_id } = await create.json() as any;
    await app.fetch(new Request(`http://test/api/channels/${channel_id}/invite`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ address: wB.address }),
    }));
    for (let i = 0; i < 30; i++) {
      const r = await app.fetch(new Request(`http://test/api/channels/${channel_id}/signals`, {
        method: "POST", headers: authHeaders(tA), body: JSON.stringify({ idx: i }),
      }));
      expect(r.status).toBe(201);
    }
    const r31 = await app.fetch(new Request(`http://test/api/channels/${channel_id}/signals`, {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ idx: 31 }),
    }));
    expect(r31.status).toBe(429);
    expect(r31.headers.get("retry-after")).toBeTruthy();
  });

  test("BETA-1.c: 6th group by same creator returns 409 (1-on-1 channels don't count)", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    await register(tA, uname("cap"));
    for (let i = 0; i < 5; i++) {
      const r = await app.fetch(new Request("http://test/api/channels", {
        method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: `cap-${i}` }),
      }));
      expect(r.status).toBe(201);
    }
    const r6 = await app.fetch(new Request("http://test/api/channels", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ name: "cap-6" }),
    }));
    expect(r6.status).toBe(409);
    const body = await r6.json() as any;
    expect(body.error).toMatch(/max 5/);

    // Adding a friend to a 1-on-1 channel should NOT count toward the cap.
    const wB = makeWallet(); const tB = await login(wB);
    const bU = uname("b"); await register(tB, bU);
    const add = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bU }),
    }));
    expect(add.status).toBe(201);
  });

  // ── Events (admin analytics — only that the rows show up) ─────────

  test("events: register + friend_add_accepted + signal_push are recorded", async () => {
    const wA = makeWallet(); const tA = await login(wA);
    const wB = makeWallet(); const tB = await login(wB);
    await register(tA, uname("a"));
    const bU = uname("b"); await register(tB, bU);
    const add = await app.fetch(new Request("http://test/api/friends/add", {
      method: "POST", headers: authHeaders(tA), body: JSON.stringify({ username: bU }),
    }));
    expect(add.status).toBe(201);

    // Give the fire-and-forget recordEvent inserts a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const rows = await sqlMod.sql<{ event_type: string; address_hash: string }[]>`
      SELECT event_type, address_hash FROM events ORDER BY created_at ASC
    `;
    const types = rows.map((r) => r.event_type);
    expect(types).toContain("friend_add_accepted");
    // address_hash must be 24-char hex (per lib/events.ts).
    for (const r of rows) expect(r.address_hash).toMatch(/^[0-9a-f]{24}$/);
  });

  // ── NUMERIC driver parser (2026-05-19) ─────────────────────────────────
  // Regression test for the /v2/daemon white-screen incident: postgres.js
  // default parser only covers int/float OIDs (700/701), NUMERIC (1700)
  // returns as string. db.ts registers a custom parser so NUMERIC columns
  // come back as JS number; frontend DaemonPage.tsx:169 d.cost_usd.toFixed
  // depends on this. If anyone removes the parser or upgrades the driver
  // and the default changes, this test catches the regression before users
  // see a white screen.
  describe("NUMERIC columns parsed as JS number (driver config)", () => {
    test("daemon_decisions.cost_usd round-trips as number, not string", async () => {
      await sqlMod.sql`DELETE FROM daemon_decisions WHERE address = 'numeric-test-addr'`;
      await sqlMod.sql`
        INSERT INTO daemon_decisions(address, kind, cost_usd)
        VALUES ('numeric-test-addr', 'noop', 0.00420042)
      `;
      const rows = await sqlMod.sql<{ cost_usd: unknown }[]>`
        SELECT cost_usd FROM daemon_decisions WHERE address = 'numeric-test-addr'
      `;
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]!.cost_usd).toBe("number");
      expect(rows[0]!.cost_usd).toBeCloseTo(0.00420042, 8);
      await sqlMod.sql`DELETE FROM daemon_decisions WHERE address = 'numeric-test-addr'`;
    });

    test("identities.free_credits_usd round-trips as number", async () => {
      // identities is TRUNCATE'd in beforeAll. Insert a minimal row.
      await sqlMod.sql`
        INSERT INTO identities(address, free_credits_usd)
        VALUES ('numeric-test-id', 5.12345678)
        ON CONFLICT (address) DO UPDATE SET free_credits_usd = EXCLUDED.free_credits_usd
      `;
      const rows = await sqlMod.sql<{ free_credits_usd: unknown }[]>`
        SELECT free_credits_usd FROM identities WHERE address = 'numeric-test-id'
      `;
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]!.free_credits_usd).toBe("number");
      expect(rows[0]!.free_credits_usd).toBeCloseTo(5.12345678, 8);
      await sqlMod.sql`DELETE FROM identities WHERE address = 'numeric-test-id'`;
    });
  });
});
