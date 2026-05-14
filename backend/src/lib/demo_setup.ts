// v4 — Server-side auto-add @demo on register + push 24h-recent replay signal.
//
// Goal: new user's daemon, on first SSE subscribe (via channel history backfill),
// sees BOTH:
//   1. @demo welcome signal (existing — explains what @demo does)
//   2. @demo most-recent real trade signal from last 24h (new — replay:true)
//
// Idempotent: safe to call multiple times. Race with concurrent /friends/add
// is handled by 23505 → reload and skip.

import { sql } from "../db.ts";
import { recordEvent } from "./events.ts";
import { publishChannel, publishUser, notifyFeedStreamsNewChannel } from "../routes/signals.ts";
import { deliverToChannelMembers } from "./webhook.ts";
import { stripControlCharsDeep } from "../../../shared/strip-control.ts";

const REPLAY_LOOKBACK_HOURS = 24;

function orderPair(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/** Server-side auto-add @demo as friend for a newly-registered user.
 *  Inserts welcome + replay signal so the user's daemon sees a live demo on
 *  first SSE subscribe (via channel history backfill).
 *
 *  Fire-and-forget recommended — failures are logged, never thrown. */
export async function ensureDemoFriend(meAddress: string, meUsername: string | null): Promise<void> {
  const demoRow = await sql<{ address: string }[]>`
    SELECT address FROM identities WHERE username = 'demo'
  `;
  if (!demoRow[0]) {
    console.log(`[demo-setup] @demo not provisioned yet; skip auto-add for ${meAddress.slice(0, 8)}…`);
    return;
  }
  const demoAddress = demoRow[0].address;
  if (demoAddress === meAddress) return;  // operator account is @demo itself

  const { a, b } = orderPair(meAddress, demoAddress);

  const existing = await sql<{ channel_id: string }[]>`
    SELECT channel_id FROM friend_links WHERE a = ${a} AND b = ${b}
  `;
  if (existing[0]) return;  // already friends — idempotent skip

  // Welcome signal payload — built before tx so its size/sanitize cost
  // doesn't extend the transaction window.
  const welcomePayload = stripControlCharsDeep({
    type: "welcome",
    source_id: "demo-welcome",
    message:
      "Connected! I'm @demo, powered by the GS PRO scanner. " +
      "I monitor Binance Futures for funding-rate flips combined with rising open interest, " +
      "then push LONG / SHORT signals when both conditions trigger. " +
      "Signal frequency varies — typically 1-5 per day depending on market conditions. " +
      "Your agent should react to this message to confirm the connection is working.",
    test_connectivity: true,
  });

  // Replay signal — query @demo's most-recent real trade signal in last 24h.
  // Done outside tx (read-only) so we know whether to insert a replay row inside the tx.
  const replayCandidate = await sql<{ payload: any; signal_id: string; created_at: Date }[]>`
    SELECT signal_id, payload, created_at
    FROM signals
    WHERE from_address = ${demoAddress}
      AND created_at > now() - interval '${sql.unsafe(String(REPLAY_LOOKBACK_HOURS))} hours'
      AND payload->>'source_id' LIKE 'GS-pro%'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  // ── ATOMIC: channel + members + friend_link + welcome signal + replay signal
  //    all in one tx. If anything fails, no partial state — user sees nothing
  //    until next register attempt (or front-end /friends/add demo) re-fires.
  let channelId: string;
  let welcomeRow: { signal_id: string; created_at: Date } | undefined;
  let replayRow: { signal_id: string; created_at: Date } | undefined;
  try {
    const result = await sql.begin(async (tx) => {
      const ch = await tx<{ channel_id: string }[]>`
        INSERT INTO channels(name, created_by, owner, is_group)
        VALUES (NULL, ${meAddress}, NULL, false)
        RETURNING channel_id
      `;
      const channel_id = ch[0]!.channel_id;
      await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${meAddress})`;
      await tx`INSERT INTO channel_members(channel_id, address) VALUES (${channel_id}, ${demoAddress})`;
      await tx`
        INSERT INTO friend_links(a, b, channel_id) VALUES (${a}, ${b}, ${channel_id})
      `;
      const welcome = await tx<{ signal_id: string; created_at: Date }[]>`
        INSERT INTO signals(channel_id, from_address, payload)
        VALUES (${channel_id}, ${demoAddress}, ${sql.json(welcomePayload as any)})
        RETURNING signal_id, created_at
      `;
      let replay: { signal_id: string; created_at: Date }[] = [];
      if (replayCandidate[0]) {
        const original = replayCandidate[0].payload;
        const replayPayload = stripControlCharsDeep({
          ...original,
          replay: true,
          replay_of_signal_id: replayCandidate[0].signal_id,
          replay_of_at: replayCandidate[0].created_at.toISOString(),
          replay_note:
            "This is a replay of @demo's most recent live signal (within 24h). " +
            "Your agent's paper trade on this signal is marked as a demo position " +
            "(not counted in your stats). Live signals arriving after this are real.",
        });
        replay = await tx<{ signal_id: string; created_at: Date }[]>`
          INSERT INTO signals(channel_id, from_address, payload)
          VALUES (${channel_id}, ${demoAddress}, ${sql.json(replayPayload as any)})
          RETURNING signal_id, created_at
        `;
      }
      return { channel_id, welcome: welcome[0], replay: replay[0] };
    });
    channelId = result.channel_id;
    welcomeRow = result.welcome;
    replayRow = result.replay;
  } catch (err: any) {
    if (err?.code === "23505") {
      // Race with concurrent /friends/add demo. Counterpart already wired the
      // channel; nothing more to do.
      return;
    }
    throw err;
  }

  // ── Side effects (publish events / record analytics) AFTER tx commits.
  //    These are best-effort — failures don't break user state.
  recordEvent({
    type: "friend_add_accepted",
    address: meAddress,
    channelId,
    payload: { auto: true, source: "register_auto" },
  });

  const createdAt = new Date().toISOString();
  publishUser(meAddress, {
    kind: "friend_accepted",
    channel_id: channelId,
    with_address: demoAddress,
    with_username: "demo",
    auto: true,
    created_at: createdAt,
  } as any);
  publishUser(demoAddress, {
    kind: "friend_accepted",
    channel_id: channelId,
    with_address: meAddress,
    with_username: meUsername,
    auto: true,
    created_at: createdAt,
  } as any);
  notifyFeedStreamsNewChannel(meAddress, channelId, {
    channel_name: null,
    peer: { address: demoAddress, username: "demo" },
  });
  notifyFeedStreamsNewChannel(demoAddress, channelId, {
    channel_name: null,
    peer: { address: meAddress, username: meUsername },
  });

  if (welcomeRow) {
    const wEvt = {
      kind: "signal" as const,
      signal_id: welcomeRow.signal_id,
      channel_id: channelId,
      from_address: demoAddress,
      from_username: "demo",
      payload: welcomePayload,
      created_at: welcomeRow.created_at.toISOString(),
    };
    publishChannel(channelId, wEvt);
    void deliverToChannelMembers(channelId, demoAddress, wEvt);
  }

  if (replayRow && replayCandidate[0]) {
    const original = replayCandidate[0].payload;
    const replayPayload = stripControlCharsDeep({
      ...original,
      replay: true,
      replay_of_signal_id: replayCandidate[0].signal_id,
      replay_of_at: replayCandidate[0].created_at.toISOString(),
      replay_note:
        "This is a replay of @demo's most recent live signal (within 24h). " +
        "Your agent's paper trade on this signal is marked as a demo position " +
        "(not counted in your stats). Live signals arriving after this are real.",
    });
    const rEvt = {
      kind: "signal" as const,
      signal_id: replayRow.signal_id,
      channel_id: channelId,
      from_address: demoAddress,
      from_username: "demo",
      payload: replayPayload,
      created_at: replayRow.created_at.toISOString(),
    };
    publishChannel(channelId, rEvt);
    void deliverToChannelMembers(channelId, demoAddress, rEvt);
    recordEvent({
      type: "replay_signal_pushed",
      channelId,
      payload: {
        replay_signal_id: replayRow.signal_id,
        source_signal_id: replayCandidate[0].signal_id,
        original_created_at: replayCandidate[0].created_at.toISOString(),
        token: original?.token ?? null,
        direction: original?.direction ?? null,
      },
    });
  }
}

// Replay logic is now inlined in `ensureDemoFriend`'s tx for atomicity.
// (Pre-tx: query candidate. Inside tx: insert. Post-tx: publish + record event.)
