// v4 — Step 3 "test connectivity" endpoint.
//
// Onboarding now gates Enter Dashboard on a successful agent loop:
//   1. user clicks "Test connectivity" in Step 3 (after installer ran)
//   2. web POSTs /connectivity-test/trigger
//   3. server pushes a trade_entry-shaped signal into the user's @demo channel
//      with `connectivity_test: true` flag. Prefer replaying @demo's most
//      recent real signal; fall back to a deterministic test payload so setup
//      does not block when the scanner has been quiet.
//   4. user's daemon receives via SSE → local agent evaluates → react +1/-1
//   5. web polls /signals/feed; detects the react → unlocks Enter Dashboard
//
// Why a trade_entry-shaped signal (not a synthetic ping)?
//   The signal flows the entire production pipeline: SSE delivery →
//   daemon agent eval → react push → paper trade entry. If anything is
//   broken (agent runner missing, daemon not running, MCP permission denied,
//   etc.) the loop fails and the user can't enter Dashboard. That's the point.
//
// Why fallback payload?
//   @demo is still the activation funnel. But a setup test must be available
//   on demand; "no recent scanner signal" is not a user-actionable failure.

import { Hono } from "hono";
import { sql } from "../db.ts";
import { authedAddress, AuthError } from "../auth.ts";
import { recordEvent } from "../lib/events.ts";
import { check as rateCheck, RateLimitedError } from "../lib/rate_limit.ts";
import { publishChannel } from "./signals.ts";
import { deliverToChannelMembers } from "../lib/webhook.ts";
import { stripControlCharsDeep } from "../../../shared/strip-control.ts";

export const connectivityTestRoutes = new Hono();

const TRIGGER_LIMIT = { windowMs: 60_000, max: 5 };
const REPLAY_LOOKBACK_HOURS = 24;

connectivityTestRoutes.post("/connectivity-test/trigger", async (c) => {
  let me: string;
  try {
    me = await authedAddress(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.reason }, e.status as 400 | 401);
    throw e;
  }
  try {
    rateCheck(`connectivity-test:${me}`, TRIGGER_LIMIT);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      c.header("Retry-After", String(e.retryAfterSec));
      return c.json({ error: "rate_limited", retry_after_sec: e.retryAfterSec }, 429);
    }
    throw e;
  }

  // Find @demo address (always-present operator account).
  const demoRow = await sql<{ address: string }[]>`
    SELECT address FROM identities WHERE username = 'demo'
  `;
  if (!demoRow[0]) {
    return c.json({ error: "demo_unavailable", message: "@demo account not provisioned" }, 503);
  }
  const demoAddress = demoRow[0].address;

  // Find the user's @demo channel.
  // friend_links uses ordered (a, b) pair where a < b.
  const { a, b } = me < demoAddress ? { a: me, b: demoAddress } : { a: demoAddress, b: me };
  const linkRow = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM friend_links WHERE a = ${a} AND b = ${b}
  `;
  if (!linkRow[0]) {
    return c.json({ error: "no_demo_channel", message: "user has no channel with @demo" }, 404);
  }
  const channelId = linkRow[0].channel_id;

  // Pull @demo's most-recent real trade signal in the lookback window.
  // Excludes welcome (source_id='demo-welcome') by filtering for GS-pro source_id.
  // Phase 14 G 🟡 — sql.unsafe replaced with parameterized make_interval.
  const candidate = await sql<{ signal_id: string; payload: any; created_at: Date }[]>`
    SELECT signal_id, payload, created_at
    FROM signals
    WHERE from_address = ${demoAddress}
      AND created_at > now() - make_interval(hours => ${REPLAY_LOOKBACK_HOURS})
      AND payload->>'source_id' LIKE 'GS-pro%'
      AND (payload->>'connectivity_test') IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const original = candidate[0]?.payload ?? {
    type: "trade_entry",
    source_id: "demo-connectivity-test",
    token: "ETHUSDT",
    direction: "long",
    confidence: 0.55,
    horizon: "connectivity_test",
    reason:
      "Connectivity test payload. This is not alpha; it exists to prove your daemon can receive, evaluate, react, and optionally open paper.",
    metadata: {
      entry_price: 3500,
      stop_loss: 3400,
      take_profit: 3700,
      leverage: 1,
      time_stop_hours: 1,
    },
  };
  const testPayload = stripControlCharsDeep({
    ...original,
    connectivity_test: true,
    connectivity_test_of_signal_id: candidate[0]?.signal_id ?? null,
    connectivity_test_at: new Date().toISOString(),
    connectivity_test_note:
      "Connectivity test — your agent should evaluate this signal and react. " +
      "Once we see your daemon react, Enter Dashboard unlocks. " +
      "This is a real-shape trade_entry; your agent's paper trade is marked as a test position.",
  });

  const inserted = await sql<{ signal_id: string; created_at: Date }[]>`
    INSERT INTO signals(channel_id, from_address, payload)
    VALUES (${channelId}, ${demoAddress}, ${sql.json(testPayload as any)})
    RETURNING signal_id, created_at
  `;
  if (!inserted[0]) {
    return c.json({ error: "insert_failed" }, 500);
  }

  const evt = {
    kind: "signal" as const,
    signal_id: inserted[0].signal_id,
    channel_id: channelId,
    from_address: demoAddress,
    from_username: "demo",
    payload: testPayload,
    created_at: inserted[0].created_at.toISOString(),
  };
  publishChannel(channelId, evt);
  void deliverToChannelMembers(channelId, demoAddress, evt);

  recordEvent({
    type: "signal_push",
    address: me,
    channelId,
    payload: { connectivity_test: true, signal_id: inserted[0].signal_id },
  });

  return c.json({
    ok: true,
    signal_id: inserted[0].signal_id,
    channel_id: channelId,
    created_at: inserted[0].created_at.toISOString(),
  });
});
