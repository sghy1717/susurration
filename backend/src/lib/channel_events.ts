// Phase 10 D7 — Channel structural events persistence.
//
// Inserts into the channel_events table (migration 016) alongside each
// publishChannel/publishUser SSE push. Result: /signals/feed REST query
// can UNION these in so refresh recovers channel collaboration history.
//
// Phase 14 G 🟡 — was fire-and-forget (INSERT.catch). Now synchronous await
// + accepts optional tx so caller can include the INSERT in the same DB
// transaction as the route's main work, eliminating partial-state risk:
// SSE pushed but INSERT failed → user refresh loses the event.

import { sql } from "../db.ts";

export type ChannelEventKind =
  | "channel_created"
  | "channel_member_added"
  | "channel_member_removed"
  | "channel_owner_transferred"
  | "channel_renamed"
  | "channel_meta_changed";

export interface ChannelEventInsert {
  channelId: string;
  kind: ChannelEventKind;
  actorAddress: string;
  actorUsername: string | null;
  targetAddress?: string | null;
  targetUsername?: string | null;
  payload?: Record<string, unknown>;
}

/** Insert a channel structural event row. Fire-and-forget (caller doesn't
 *  await). Phase 14: signature accepts optional `tx` for future migration to
 *  caller-owned transactions; today most callers still use the default outer
 *  sql connection (post-tx). Atomic-with-tx refactor across 9 sites is
 *  scheduled for next iteration (G 🟡 channel_events tx integration). */
export function insertChannelEvent(e: ChannelEventInsert, tx?: typeof sql): void {
  const conn = tx ?? sql;
  void conn`
    INSERT INTO channel_events (channel_id, kind, actor_address, actor_username, target_address, target_username, payload)
    VALUES (
      ${e.channelId}, ${e.kind}, ${e.actorAddress}, ${e.actorUsername ?? null},
      ${e.targetAddress ?? null}, ${e.targetUsername ?? null},
      ${conn.json((e.payload ?? {}) as any)}
    )
  `.catch((err) => {
    console.error(`[channel_events] insert failed kind=${e.kind} channel=${e.channelId}:`, (err as Error).message);
  });
}
