// Phase 17.5 — Paper close retry queue.
//
// Problem: daemon trackPositions() decides to close a position locally, then
// fires `syncPaperClose` to mirror to server. Pre-Phase-17.5, that call was
// fire-and-forget with `.catch(() => {})` — if it failed (network blip, server
// 500, daemon crash mid-flight), server never learned the close happened and
// the position stayed "open" on server / dashboard forever.
//
// Fix: every close attempt goes through this persistent queue:
//   1. enqueue(close-payload)  — append + write ~/.susu/paper_close_queue.json
//   2. flush()                 — try each entry whose next_attempt_at <= now
//   3. on success: remove entry from queue
//   4. on failure: increment attempts + reschedule with exponential backoff
//   5. on MAX_ATTEMPTS reached: entry stays in queue indefinitely and continues
//      to retry every STALE_BACKOFF_MS (1h). This is intentional self-healing
//      behavior — server is idempotent, so when network / auth recovers a
//      retry succeeds and the entry dequeues. CLI `susu book --queue` shows
//      these as "stale" so operators know operator attention may be needed,
//      but daemon keeps trying. Closes are never silently dropped.
//
// Idempotency: server's POST /positions/close is idempotent
// (UPDATE ... WHERE closed_at IS NULL). So retry of an already-processed close
// returns 200 with idempotent=true → we dequeue normally. No daemon-side dedup
// against server needed.
//
// In-process dedup: enqueue is keyed by signal_id; same signal_id can't be
// queued twice. trackPositions() only sets t.status="closed" once per trade,
// so this is defensive — shouldn't happen in normal flow.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { syncPaperClose, type SusuClientConfig } from "./susu_actions.ts";

const MAX_ATTEMPTS = 5;
// Backoff schedule in ms, indexed by attempt count (0 = next try delay after first failure).
// 10s → 30s → 2min → 10min → 1h. After MAX_ATTEMPTS, holds at 1h forever
// (so monitor can see stale queue but daemon doesn't burn CPU on dead entries).
const BACKOFF_SCHEDULE_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000];
const STALE_BACKOFF_MS = 3_600_000;

export interface ClosePayload {
  signal_id: string;
  exit_reason: string;
  exit_price: number;
  exit_pnl_pct: number;
  exit_pnl_usd?: number;
  closed_at: string;
}

interface QueueEntry {
  payload: ClosePayload;
  attempts: number;
  first_enqueued_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
  /** ISO timestamp; flush() skips entries whose next_attempt_at > now */
  next_attempt_at: string;
}

interface QueueFile {
  entries: QueueEntry[];
}

export class PaperCloseQueue {
  /** Set to true while a flush is in flight to prevent re-entrant flushes
   *  from overlapping syncs to the same signal_id. */
  private flushInFlight = false;

  constructor(
    private queuePath: string,
    private susuClient: SusuClientConfig | null,
  ) {
    mkdirSync(dirname(queuePath), { recursive: true });
  }

  /** Add a close to the queue. Dedupe by signal_id — if it's already pending,
   *  we keep the earlier entry (preserves original first_enqueued_at + attempts
   *  count for monitoring). Also called from `trackPositions` after every
   *  successful local close. */
  enqueue(payload: ClosePayload): void {
    if (!this.susuClient) return;
    const q = this.load();
    if (q.entries.some((e) => e.payload.signal_id === payload.signal_id)) return;
    q.entries.push({
      payload,
      attempts: 0,
      first_enqueued_at: new Date().toISOString(),
      last_attempt_at: null,
      last_error: null,
      // First attempt happens immediately on next flush() call.
      next_attempt_at: new Date(0).toISOString(),
    });
    this.save(q);
  }

  /** Try every due entry. Idempotent — safe to call from multiple places
   *  (startup, trackPositions tick, manual CLI invocation). */
  async flush(): Promise<{ tried: number; ok: number; failed: number; stale: number }> {
    if (!this.susuClient) return { tried: 0, ok: 0, failed: 0, stale: 0 };
    if (this.flushInFlight) return { tried: 0, ok: 0, failed: 0, stale: 0 };
    this.flushInFlight = true;
    try {
      const q = this.load();
      const now = Date.now();
      const due = q.entries.filter((e) => new Date(e.next_attempt_at).getTime() <= now);
      if (due.length === 0) return { tried: 0, ok: 0, failed: 0, stale: 0 };

      let ok = 0;
      let failed = 0;
      let stale = 0;
      const keep: QueueEntry[] = [];

      for (const entry of q.entries) {
        if (new Date(entry.next_attempt_at).getTime() > now) {
          keep.push(entry);
          continue;
        }
        try {
          await syncPaperClose(this.susuClient, entry.payload);
          ok++;
          // Success — drop the entry (server now owns it, daemon doesn't need
          // to remember).
        } catch (err) {
          entry.attempts++;
          entry.last_attempt_at = new Date().toISOString();
          entry.last_error = (err as Error)?.message?.slice(0, 200) ?? "unknown";
          if (entry.attempts >= MAX_ATTEMPTS) {
            entry.next_attempt_at = new Date(now + STALE_BACKOFF_MS).toISOString();
            stale++;
          } else {
            const backoff = BACKOFF_SCHEDULE_MS[entry.attempts - 1] ?? STALE_BACKOFF_MS;
            entry.next_attempt_at = new Date(now + backoff).toISOString();
            failed++;
          }
          keep.push(entry);
        }
      }
      this.save({ entries: keep });
      return { tried: due.length, ok, failed, stale };
    } finally {
      this.flushInFlight = false;
    }
  }

  /** For CLI / Y monitoring — return queue depth + oldest entry age + stale
   *  count without performing any sync. */
  status(): {
    depth: number;
    stale: number;
    oldest_age_sec: number | null;
    next_due_in_sec: number | null;
    entries: Array<{
      signal_id: string;
      attempts: number;
      first_enqueued_at: string;
      last_error: string | null;
      next_attempt_at: string;
    }>;
  } {
    const q = this.load();
    const now = Date.now();
    let oldest: number | null = null;
    let nextDue: number | null = null;
    let stale = 0;
    for (const e of q.entries) {
      const enqAge = (now - new Date(e.first_enqueued_at).getTime()) / 1000;
      if (oldest === null || enqAge > oldest) oldest = enqAge;
      const due = (new Date(e.next_attempt_at).getTime() - now) / 1000;
      if (nextDue === null || due < nextDue) nextDue = due;
      if (e.attempts >= MAX_ATTEMPTS) stale++;
    }
    return {
      depth: q.entries.length,
      stale,
      oldest_age_sec: oldest === null ? null : Math.round(oldest),
      next_due_in_sec: nextDue === null ? null : Math.round(nextDue),
      entries: q.entries.map((e) => ({
        signal_id: e.payload.signal_id,
        attempts: e.attempts,
        first_enqueued_at: e.first_enqueued_at,
        last_error: e.last_error,
        next_attempt_at: e.next_attempt_at,
      })),
    };
  }

  private load(): QueueFile {
    try {
      const parsed = JSON.parse(readFileSync(this.queuePath, "utf8"));
      if (Array.isArray(parsed?.entries)) return parsed as QueueFile;
      return { entries: [] };
    } catch {
      return { entries: [] };
    }
  }

  private save(q: QueueFile): void {
    // Atomic write — daemon crash mid-write would otherwise truncate the
    // queue file (open O_TRUNC + write), and next load() would silently
    // catch the JSON parse error and reset to empty, **losing all pending
    // closes** — the exact failure mode this queue exists to prevent.
    // Write to .tmp + rename is atomic on POSIX (rename(2)).
    const tmp = `${this.queuePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(q, null, 2));
    renameSync(tmp, this.queuePath);
  }
}
