// Phase 18.2 — Live-position monitor.
//
// Susurration's PaperTrader handles paper-mode positions end-to-end: it has
// price feeds, SL / TP / trailing logic, and writes /positions/close when a
// stop hits. Live-mode positions are different — the broker (not susurration)
// is the source of truth for fills. The agent's broker MCP knows when a
// position closes; susurration only learns about it when the agent reports
// back via susu_position_close.
//
// The monitor wakes the agent on a slow cadence (default 30 min) when there
// are open live positions on the server. Spawn cost is real (each invocation
// is a claude / codex run that costs money), so:
//   • If 0 live positions are open, the tick is free (just a GET).
//   • If >0, the agent is spawned with a LIVE_MONITOR prompt that lists the
//     open positions and asks the agent to reconcile each one against the
//     broker MCP, closing any that the broker has filled out.
//
// Cadence isn't aggressive on purpose. Live trades don't change second-to-
// second from the daemon's perspective — the user is in control via their
// broker UI / agent. The monitor exists as a backstop so a position that
// closed at the broker doesn't sit "open" on the susurration dashboard for
// hours. Users who want tighter loop should lower interval_ms in their
// agent-config or call susu_position_close directly from another flow.

import type { SusuClientConfig } from "./susu_actions.ts";
import type { IdeAgentRunner, RunnerResult } from "./agent_runner.ts";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes

export interface LivePositionRow {
  position_id: string;
  signal_id?: string;
  channel_id?: string;
  token: string;
  direction: "long" | "short";
  leverage: number;
  entry_price: number;
  stop_loss?: number;
  take_profit?: number;
  position_usd: number;
  size_factor?: number | null;
  broker_position_id?: string | null;
  peer_username?: string | null;
  opened_at?: string;
}

export class LivePositionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Phase 18.2-w — promise for the running tick so shutdown can await it.
   *  A tick that spawned the IDE-agent may have outstanding broker MCP
   *  calls + susu_position_close writes in flight; cutting the daemon
   *  process mid-call would lose them. */
  private inFlightTick: Promise<void> | null = null;

  constructor(
    private susu: SusuClientConfig,
    private runner: IdeAgentRunner,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    // First tick fires after one interval — we don't tickle on startup
    // because daemon startup is already a busy moment and a freshly-started
    // daemon has nothing new to discover that the close-queue flush + paper
    // sync haven't already covered.
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  /** Stop the monitor and AWAIT the running tick if any. Phase 18.2-w —
   *  was synchronous, which silently abandoned an in-flight agent spawn
   *  (up to runner.timeout_ms of broker reconciliation work). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlightTick) {
      try { await this.inFlightTick; } catch { /* swallow; tick logs its own errors */ }
    }
  }

  /** Visible for testing — runs one tick. */
  async tick(): Promise<void> {
    if (this.inFlightTick) {
      // Don't pile up agent spawns if a previous tick is still going (claude
      // can take up to runner.timeout_ms; intervalMs may be tighter).
      return;
    }
    this.inFlightTick = (async () => {
      try {
        const open = await this.fetchOpenLive();
        if (open.length === 0) return; // free no-op
        process.stderr.write(
          `[live-monitor] ${open.length} open live position(s); spawning agent to reconcile\n`,
        );
        const result = await this.runner.invokeLiveMonitor(open);
        this.logResult(result);
      } catch (e) {
        process.stderr.write(`[live-monitor] tick error: ${(e as Error)?.message ?? e}\n`);
      }
    })().finally(() => {
      this.inFlightTick = null;
    });
    await this.inFlightTick;
  }

  private async fetchOpenLive(): Promise<LivePositionRow[]> {
    const url = this.susu.api_url.replace(/\/$/, "") + "/positions/mine?status=open&mode=live&limit=100";
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${this.susu.token}` },
    });
    if (!resp.ok) {
      process.stderr.write(`[live-monitor] GET /positions/mine?mode=live → HTTP ${resp.status}; skipping tick\n`);
      return [];
    }
    const body = await resp.json() as any;
    const rows = body?.positions;
    return Array.isArray(rows) ? (rows as LivePositionRow[]) : [];
  }

  private logResult(result: RunnerResult): void {
    if (!result.ok) {
      process.stderr.write(
        `[live-monitor] agent exit=${result.exit_code} dur=${result.duration_ms}ms\n` +
        `              stderr: ${result.stderr_tail.slice(-300)}\n`,
      );
      return;
    }
    process.stderr.write(
      `[live-monitor] agent ok dur=${result.duration_ms}ms (susurration learns about closes via susu_position_close)\n`,
    );
  }
}
