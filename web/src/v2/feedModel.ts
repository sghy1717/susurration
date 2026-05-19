export interface FeedLikeEvent {
  kind: string;
  signal_id?: string | null;
  reaction_id?: string | null;
  parent_signal_id?: string | null;
  from_address?: string | null;
  from_username?: string | null;
  payload?: any;
  created_at: string;
}

export const FEED_SSE_EVENT_TYPES = [
  "signal",
  "reaction",
  "channel_member_added",
  "channel_member_removed",
  "channel_meta_changed",
  "channel_owner_transferred",
  "channel_renamed",
  "friend_request",
  "friend_accepted",
  "friend_removed",
  "channel_invited",
  "channel_created",
  "system",
] as const;

export function reactionParentSignalId(event: FeedLikeEvent): string | null {
  return event.parent_signal_id ?? event.signal_id ?? null;
}

export function ownReactionsBySignalId<T extends FeedLikeEvent>(
  events: T[],
  myAddress: string | null | undefined,
): Map<string, T> {
  const m = new Map<string, T>();
  if (!myAddress) return m;

  for (const event of events) {
    const parentSignalId = reactionParentSignalId(event);
    if (event.kind === "reaction" && event.from_address === myAddress && parentSignalId) {
      m.set(parentSignalId, event);
    }
  }

  return m;
}
