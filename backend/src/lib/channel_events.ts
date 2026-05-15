// Phase 10 D7 — Channel structural events persistence.
//
// Inserts into the channel_events table (migration 016) alongside each
// publishChannel/publishUser SSE push. Result: /signals/feed REST query
// can UNION these in so refresh recovers channel collaboration history.
//
// Fire-and-forget: failures are logged but never block the route.

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

export function insertChannelEvent(e: ChannelEventInsert): void {
  void sql`
    INSERT INTO channel_events (channel_id, kind, actor_address, actor_username, target_address, target_username, payload)
    VALUES (
      ${e.channelId}, ${e.kind}, ${e.actorAddress}, ${e.actorUsername ?? null},
      ${e.targetAddress ?? null}, ${e.targetUsername ?? null},
      ${sql.json((e.payload ?? {}) as any)}
    )
  `.catch((err) => {
    console.error(`[channel_events] insert failed kind=${e.kind} channel=${e.channelId}:`, (err as Error).message);
  });
}
