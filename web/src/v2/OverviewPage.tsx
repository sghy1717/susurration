// Overview page — Hero PnL + KPI strip + open positions + equity curve +
// recent activity + agent state + top peers + channels. All data live from
// real backend endpoints, no placeholders.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Shell, useNow } from "./Shell";
import {
  useBookSnapshot, useBookEquity, useOpenPositions, useDaemonState,
  usePeersStats, useChannelGroups, useSignalFeed, usePrices,
  pnlOf, durationStr, formatMoney, formatPnl, formatPercent,
  type Position, type ModeFilter,
} from "./hooks";
import {
  Eyebrow, SectionTitle, Tag, TickValue, KpiStrip, Avatar,
  EquityCurve, ReadOnlyFootnote, ModeFilterPill, ModeBadge, PriceSlider,
  StructuredEventCard, formatClock,
} from "./components";

export function OverviewPage() {
  return (
    <Shell pageLabel="overview">
      <OverviewBody />
    </Shell>
  );
}

function OverviewBody() {
  // Phase 18.2 — mode is dashboard-local state (no need to persist yet; the
  // toggle is a glance-level convenience, not a setting). All hero data flows
  // off this so a single click reshapes every KPI on the page.
  const [mode, setMode] = useState<ModeFilter>("all");
  const { data: snapshot, loading: snapLoading } = useBookSnapshot(mode);
  // Phase 18.2-w — for the equity curve we fetch BOTH paper and live so that
  // mode=all can overlay them as two lines. usePoll's 60s interval keeps the
  // double fetch cheap. Single-mode views just ignore the unused side.
  const { data: equityPaperResp } = useBookEquity(21, "paper");
  const { data: equityLiveResp } = useBookEquity(21, "live");
  const equity = mode === "live" ? equityLiveResp : equityPaperResp;
  const equitySecondary = mode === "all" ? equityLiveResp : null;
  const { data: positionsResp } = useOpenPositions(mode);
  const { data: peers } = usePeersStats(30);
  const { data: channels } = useChannelGroups();
  const { data: feed } = useSignalFeed(20);

  const positions = positionsResp?.positions ?? [];
  const tokens = useMemo(() => Array.from(new Set(positions.map(p => p.token))), [positions]);
  const { data: prices } = usePrices(tokens, 1500);

  const now = useNow(1000);

  // Total unrealized: sum pnlOf across open positions using live marks.
  const unrealized = useMemo(() => {
    if (!prices?.prices) return 0;
    return positions.reduce((sum, p) => {
      const mark = prices.prices[p.token];
      if (mark == null || !Number.isFinite(mark)) return sum;
      return sum + pnlOf(p, mark);
    }, 0);
  }, [positions, prices]);

  const initial = snapshot?.initial_balance_usd ?? 100_000;
  const realized = snapshot?.realized_pnl_total ?? 0;
  const balance = initial + realized + unrealized;
  const totalPnl = balance - initial;
  const pctVsInitial = (totalPnl / initial) * 100;

  return (
    <>
      <div style={{
        marginBottom: "var(--susu-s-6)",
        display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        gap: "var(--susu-s-4)",
      }}>
        <div>
          <Eyebrow>book · last 21 days</Eyebrow>
          {/* Phase 18.2-w UX pass — reserve two lines of height so the
              hero doesn't reflow between 1 and 2 lines as the live PnL
              digit count changes (e.g. +$471.53 fits one line, +$1,034.00
              wraps to two). Below content (KPI strip, panels) stays put.
              line-height in tokens.css is 1.12; 2 × 1.12em + a little
              slack covers descenders and the gap. */}
          <h1
            className="susu-h1"
            style={{
              marginTop: "var(--susu-s-2)",
              minHeight: "2.4em",
            }}
          >
            Your agent traded{" "}
            <TickValue
              value={totalPnl}
              format={v => formatPnl(typeof v === "number" ? v : Number(v))}
              style={{ color: totalPnl >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}
            />{" "}
            while you slept.
          </h1>
        </div>
        <div style={{ display: "flex", gap: "var(--susu-s-3)", flexShrink: 0, alignItems: "center" }}>
          <ModeFilterPill value={mode} onChange={setMode} />
          <div style={{ display: "flex", gap: "var(--susu-s-2)" }}>
            <button className="susu-btn">21d</button>
            <button className="susu-btn susu-btn-ghost">7d</button>
            <button className="susu-btn susu-btn-ghost">24h</button>
          </div>
        </div>
      </div>

      <KpiStrip cells={[
        {
          label: "Balance",
          value: <TickValue value={balance} format={v => formatMoney(typeof v === "number" ? v : Number(v))} />,
          meta: <TickValue value={pctVsInitial} format={v => formatPercent((typeof v === "number" ? v : Number(v)) / 100)} /> ,
          metaTone: totalPnl >= 0 ? "pos" : "neg",
        },
        {
          label: "Win rate",
          value: snapshot?.win_rate != null ? `${Math.round(snapshot.win_rate * 100)}%` : "—",
          meta: snapshot ? `${snapshot.wins} wins · ${snapshot.losses} losses · ${snapshot.closed_count} closed` : (snapLoading ? "loading…" : "—"),
        },
        {
          label: "Signals received",
          value: snapshot?.signals_received_24h ?? "—",
          meta: snapshot ? (
            <>react +1 · <TickValue value={snapshot.accepted_24h} /> {snapshot.accept_rate_24h != null ? `(${Math.round(snapshot.accept_rate_24h * 100)}%)` : ""}</>
          ) : "—",
        },
        {
          label: "Open positions",
          value: positions.length,
          meta: <>unrealized <TickValue value={unrealized} format={v => formatPnl(typeof v === "number" ? v : Number(v))} style={{ color: unrealized >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }} /></>,
        },
      ]} />

      <div style={{
        display: "grid",
        gridTemplateColumns: "2fr 1fr",
        gap: "var(--susu-s-6)",
        marginTop: "var(--susu-s-8)",
      }}>
        <div>
          <section className="susu-section">
            <SectionTitle aux={`${positions.length} open${mode !== "all" ? ` · ${mode}` : ""}${positions[0]?.opened_at ? ` · marked at ${formatClock(new Date().toISOString())} UTC` : ""}`}>
              Open positions
            </SectionTitle>
            {/* Phase 18.2-w UX pass — fixed min-height so toggling
                ALL/PAPER/LIVE (or any change that shrinks the row count
                to 0) doesn't yank the equity curve + activity panels up
                the page. Empty state centers vertically inside the
                reserved space. */}
            <div className="susu-panel" style={{ minHeight: 320, position: "relative" }}>
              {positions.length === 0 ? (
                <div
                  className="susu-empty"
                  style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  No open positions — your daemon is watching.
                </div>
              ) : (
                <table className="susu-table" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Mode</th>
                      <th>Side</th>
                      <th>From</th>
                      <th>SL · Mark · TP</th>
                      <th className="num">PnL</th>
                      <th className="num">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(p => (
                      <PositionRow key={p.position_id} p={p} mark={prices?.prices?.[p.token] ?? null} now={now} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="susu-section">
            <SectionTitle aux={
              !equity ? "loading…"
              : mode === "all" ? `paper + live · ${equity.points.length} days`
              : `${mode} only · ${equity.points.length} days`
            }>
              Equity curve
            </SectionTitle>
            {equity && (
              <EquityCurve
                points={equity.points}
                secondaryPoints={equitySecondary?.points}
                initialBalance={initial}
                primaryColor={mode === "live" ? "#f6c177" : "#34d399"}
                primaryLabel={mode === "all" ? "paper" : undefined}
              />
            )}
            {/* Phase 18.2-w (H P3b) — one-sentence prose summary so the
                page answers "what happened?" without anyone reading the
                chart. Generated from snapshot, not hand-written. */}
            {snapshot && <EquityNarrative snapshot={snapshot} />}
          </section>

          <section className="susu-section">
            <SectionTitle aux={<Link to="/v2/feed" className="susu-btn susu-btn-ghost susu-btn-sm">View full feed →</Link>}>
              Recent activity
            </SectionTitle>
            {/* Phase 18.2-w (H P1) — Recent activity uses StructuredEventCard:
                full mono key:value block per event, colour-coded so the
                payload is readable at a glance. Compact mode would skip
                the block; on Overview we want the depth, just bounded
                to 4 events. Full history at /v2/feed. */}
            <div className="susu-panel" style={{ padding: 0 }}>
              {feed?.signals.length ? (
                feed.signals.slice(0, 4).map((ev, i) => (
                  <StructuredEventCard
                    key={ev.signal_id ?? ev.reaction_id ?? i}
                    ev={ev as any}
                  />
                ))
              ) : (
                <div className="susu-empty">No recent activity. Once your daemon sees signals they appear here.</div>
              )}
            </div>
          </section>
        </div>

        <div>
          <AgentStatePanel />
          <TopPeersPanel peers={peers?.peers ?? []} />
          <ChannelsPanel channels={channels?.groups ?? []} />
        </div>
      </div>

      <ReadOnlyFootnote />
    </>
  );
}

// Phase 18.2-w (H P3b) — one-sentence equity summary. Plain English so a
// human glancing at the page knows the shape of the period without reading
// the chart. We deliberately keep it factual and short; no editorializing
// like "great week!" — the data should speak.
function EquityNarrative({ snapshot }: { snapshot: any }) {
  const { wins, losses, break_even, closed_count, realized_pnl_total, initial_balance_usd } = snapshot;
  if (!closed_count) {
    return (
      <p style={{
        marginTop: "var(--susu-s-3)",
        fontFamily: "var(--susu-mono)", fontSize: 12, lineHeight: 1.6,
        color: "var(--susu-ink-subtle)",
        maxWidth: "60ch",
      }}>
        No closed trades in this window yet. Once your agent's first trip
        completes, this line will tell you how it went.
      </p>
    );
  }
  const pct = (realized_pnl_total / initial_balance_usd) * 100;
  const isUp = realized_pnl_total >= 0;
  const winRate = Math.round((wins / closed_count) * 100);
  const beClause = break_even > 0 ? `, ${break_even} break-even` : "";
  const trailing = isUp
    ? (winRate >= 60 ? "The slow drift continues." : "Mixed run — losses outpace wins on count but the dollar tape is up.")
    : (winRate >= 50 ? "Wins out-number losses but the dollar tape is red — losers ran bigger than winners." : "Rough stretch. Worth pausing to re-check the conv threshold.");
  return (
    <p style={{
      marginTop: "var(--susu-s-3)",
      fontFamily: "var(--susu-mono)", fontSize: 12, lineHeight: 1.6,
      color: "var(--susu-ink-subtle)",
      maxWidth: "60ch",
    }}>
      <strong style={{ color: "var(--susu-ink)", fontWeight: 500 }}>
        {wins} {wins === 1 ? "win" : "wins"}, {losses} {losses === 1 ? "loss" : "losses"}{beClause}
      </strong>{" "}
      across {closed_count} closed{" "}
      {closed_count === 1 ? "trade" : "trades"} ·{" "}
      <span style={{ color: isUp ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {isUp ? "+" : ""}{pct.toFixed(2)}%
      </span>{" "}
      vs initial. {trailing}
    </p>
  );
}

function PositionRow({ p, mark, now }: { p: Position; mark: number | null; now: number }) {
  const pnl = mark != null ? pnlOf(p, mark) : null;
  // Phase 18.2-w fix: pnlOf already factors direction into its sign — a
  // winning short returns a positive pnl. Previously we multiplied pnl
  // by dirSign again in the color check, which flipped the colour on
  // every short. Drop the extra factor: green when pnl is genuinely
  // positive, red when negative.
  return (
    <tr>
      <td><strong className="susu-mono" style={{ color: "var(--susu-ink)" }}>{p.token}</strong></td>
      <td><ModeBadge mode={p.mode ?? "paper"} /></td>
      <td><Tag kind={p.direction === "long" ? "long" : "short"}>{p.direction.toUpperCase()} · {p.leverage}x</Tag></td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-2)" }}>
          {p.peer_username ? <Avatar seed={p.peer_username} size={20} /> : <Avatar seed="?" size={20} />}
          <span className="susu-mono">{p.peer_username ? `@${p.peer_username}` : "—"}</span>
        </div>
      </td>
      <td>
        {/* Phase 18.2-w (H P2) — slider replaces the Entry+Mark column pair.
            "Distance to SL vs distance to TP" is the question users actually
            ask while scanning; a horizontal bar answers it without arithmetic. */}
        <PriceSlider
          direction={p.direction}
          entry={p.entry_price}
          sl={p.stop_loss}
          tp={p.take_profit}
          mark={mark}
        />
      </td>
      <td className="num" style={{ color: pnl == null ? "var(--susu-ink-subtle)" : pnl >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {pnl == null ? "—" : (
          <TickValue value={pnl} format={v => formatPnl(typeof v === "number" ? v : Number(v))} />
        )}
      </td>
      <td className="num">{durationStr(p.opened_at, now)}</td>
    </tr>
  );
}

function AgentStatePanel() {
  const { data: daemon } = useDaemonState();
  const now = useNow();
  if (!daemon) return null;

  const rows: Array<[string, React.ReactNode]> = [
    ["daemon", daemon.status === "online" && daemon.started_at
      ? <>online · {durationStr(daemon.started_at, now)}</>
      : daemon.status],
    ["provider", daemon.provider ?? "—"],
    ["execution", daemon.execution_mode
      ? <Tag kind={daemon.execution_mode === "live" ? "live" : "paper"}>{daemon.execution_mode.toUpperCase()}</Tag>
      : <span style={{ color: "var(--susu-ink-subtle)" }}>—</span>],
    ["broker", daemon.broker_connected ? "connected" : <span style={{ color: "var(--susu-ink-subtle)" }}>not connected</span>],
    ["conv threshold", daemon.conv_threshold != null ? daemon.conv_threshold.toFixed(2) : "—"],
    ["min size factor", daemon.min_size_factor != null ? daemon.min_size_factor.toFixed(2) : "—"],
    ["version", daemon.version ? `v${daemon.version}` : "—"],
  ];

  return (
    <section className="susu-section">
      <SectionTitle>Agent state</SectionTitle>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{
            display: "flex", justifyContent: "space-between",
            padding: "var(--susu-s-2) var(--susu-s-3)",
            fontFamily: "var(--susu-mono)", fontSize: 12,
          }}>
            <span style={{ color: "var(--susu-ink-subtle)" }}>{k}</span>
            <span style={{ color: "var(--susu-ink)" }}>{v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TopPeersPanel({ peers }: { peers: any[] }) {
  return (
    <section className="susu-section">
      <SectionTitle aux={<Link to="/v2/friends" className="susu-btn susu-btn-ghost susu-btn-sm">All →</Link>}>
        Top peers · 30d
      </SectionTitle>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {peers.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>No peer activity yet.</div>
        ) : peers.slice(0, 6).map((p, i) => (
          <div key={p.address ?? i} style={{
            display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
            padding: "var(--susu-s-2) var(--susu-s-3)",
          }}>
            <Avatar seed={p.username ?? p.address} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="susu-mono" style={{ fontSize: 12 }}>{p.username ? `@${p.username}` : `${p.address?.slice(0, 6) ?? "—"}…`}</div>
              <div style={{ fontSize: 10, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
                {p.signal_count} signals
                {p.accept_rate != null ? ` · ${Math.round(p.accept_rate * 100)}% accept` : ""}
                {p.top_assets?.length > 0 ? ` · ${p.top_assets.join("/")}` : ""}
              </div>
            </div>
            <div className="susu-mono" style={{
              fontSize: 12,
              color: p.realized_pnl_usd >= 0 ? "var(--susu-pos)" : "var(--susu-neg)",
            }}>
              {formatPnl(p.realized_pnl_usd)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChannelsPanel({ channels }: { channels: any[] }) {
  return (
    <section className="susu-section">
      <SectionTitle aux={`${channels.length} channels`}>Channels</SectionTitle>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {channels.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>No channels yet.</div>
        ) : channels.slice(0, 8).map(c => (
          <div key={c.channel_id} style={{
            display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
            padding: "var(--susu-s-2) var(--susu-s-3)",
          }}>
            <div className="susu-avatar">#</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="susu-mono" style={{ fontSize: 12 }}>{c.name ?? c.channel_id.slice(0, 8)}</div>
              <div style={{ fontSize: 10, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
                {c.member_count} members
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
