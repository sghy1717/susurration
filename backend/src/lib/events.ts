// BETA event instrumentation. Fire-and-forget, never blocks the request.
//
// Distinct from `usage_log` (which is billing truth, written sync inside the
// charge transaction). `events` is for behavior analytics:
//   - funnel (register → first push %)
//   - retention (D1/D7/D30)
//   - friend graph density
//   - feature adoption (meta KV usage, etc.)
//
// PII: addresses are stored as hash(address || SUSU_EVENTS_HASH_SALT). Same
// user → same hash → admin can JOIN events by user across time. But hash is
// one-way → admin cannot reverse-resolve to address. Salt is per-deploy
// (rotate on operator demand to invalidate historical correlation).
//
// Timing: callers fire events AFTER the response transaction has committed.
// On error paths, the catch block fires `event_type='error'` separately.

import { createHash } from "node:crypto";
import { sql } from "../db.ts";
import { config } from "../config.ts";

export type EventType =
  | "auth_signin"
  | "register"
  | "register_failed"
  | "friend_add_request"
  | "friend_add_accepted"
  | "friend_add_failed"
  | "friend_remove"
  | "channel_create"
  | "channel_invite"
  | "channel_kick"
  | "channel_leave"
  | "channel_meta_update"
  | "channel_rename"
  | "owner_auto_elected"
  | "transfer_owner"
  | "signal_push"
  | "reaction_push"
  | "approve_signed"
  | "charge_attempted"
  | "charge_failed"
  | "client_error"
  | "onboarding_event"
  | "daemon_decision"
  // v4 — one-shot installer + dashboard indicator + replay signal telemetry
  | "installer_started"
  | "installer_ide_detected"
  | "installer_stage_tick"
  | "installer_complete"
  | "replay_signal_pushed"
  | "dashboard_indicator_view"
  | "dashboard_indicator_click"
  | "error";

export interface RecordEventArgs {
  type: EventType;
  address?: string | null;
  channelId?: string | null;
  payload?: Record<string, unknown>;
}

export function hashAddress(address: string): string {
  // hash = sha256(address || salt). Truncate to 24 hex chars (96 bit) — plenty
  // unique for our scale (10^4-10^6 users), saves DB space.
  return createHash("sha256")
    .update(address)
    .update(config.eventsHashSalt)
    .digest("hex")
    .slice(0, 24);
}

/** Fire-and-forget event write. Returns void immediately; the actual DB write
 *  happens asynchronously. Errors are swallowed (logged to stderr) — analytics
 *  loss is acceptable, never block business flow. */
export function recordEvent(args: RecordEventArgs): void {
  // Capture inputs before async dispatch (caller may mutate `payload`).
  const type = args.type;
  const addressHash = args.address ? hashAddress(args.address) : null;
  const channelId = args.channelId ?? null;
  const payload = args.payload ?? {};

  // Don't await — let the request finish.
  void sql`
    INSERT INTO events(address_hash, event_type, channel_id, payload)
    VALUES (${addressHash}, ${type}, ${channelId}, ${sql.json(payload as any)})
  `.catch((err) => {
    console.error(`[events] write failed type=${type}:`, err.message);
  });
}
