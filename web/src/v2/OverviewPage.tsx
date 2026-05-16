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
  type Position, type FeedItem, type ModeFilter,
} from "./hooks";
import {
  Eyebrow, SectionTitle, Tag, TickValue, KpiStrip, Avatar,
  EquityCurve, ReadOnlyFootnote, ModeFilterPill, ModeBadge, formatClock,
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
  const { data: equity } = useBookEquity(21, mode);
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
          <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>
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
            <div className="susu-panel">
              {positions.length === 0 ? (
                <div className="susu-empty">No open positions — your daemon is watching.</div>
              ) : (
                <table className="susu-table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Mode</th>
                      <th>Side</th>
                      <th>From</th>
                      <th className="num">Entry</th>
                      <th className="num">Mark</th>
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
              equity ? `${formatMoney(initial)} → ${formatMoney(balance)} · ${equity.points.length} days${mode !== "all" ? ` · ${mode}` : ""}` : "loading…"
            }>
              Equity curve
            </SectionTitle>
            {equity && <EquityCurve points={equity.points} initialBalance={initial} />}
          </section>

          <section className="susu-section">
            <SectionTitle aux={<Link to="/v2/feed" className="susu-btn susu-btn-ghost susu-btn-sm">View full feed →</Link>}>
              Recent activity
            </SectionTitle>
            <div className="susu-panel">
              {feed?.signals.length ? (
                feed.signals.slice(0, 6).map((ev, i) => <RecentRow key={ev.signal_id ?? ev.reaction_id ?? i} ev={ev} />)
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

function PositionRow({ p, mark, now }: { p: Position; mark: number | null; now: number }) {
  const dirSign = p.direction === "long" ? 1 : -1;
  const pnl = mark != null ? pnlOf(p, mark) : null;
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
      <td className="num">{p.entry_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td className="num">{mark != null ? (
        <TickValue value={mark} format={v => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
      ) : "—"}</td>
      <td className="num" style={{ color: pnl == null ? "var(--susu-ink-subtle)" : pnl * dirSign >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {pnl == null ? "—" : (
          <TickValue value={pnl} format={v => formatPnl(typeof v === "number" ? v : Number(v))} />
        )}
      </td>
      <td className="num">{durationStr(p.opened_at, now)}</td>
    </tr>
  );
}

function RecentRow({ ev }: { ev: FeedItem }) {
  const isReact = ev.kind === "reaction";
  const isClose = ev.kind === "close";
  const isSignal = ev.kind === "signal";
  const side = ev.payload?.side ?? ev.payload?.direction;
  const handle = ev.from_username ? `@${ev.from_username}` : `${ev.from_address.slice(0, 6)}…`;
  const channel = ev.channel_name ?? "DM";
  return (
    <div className="susu-feed-row" style={{ gridTemplateColumns: "88px 1fr auto", borderBottom: "1px solid var(--susu-hairline)" }}>
      <div className="susu-feed-time">{formatClock(ev.created_at)}</div>
      <div className="susu-feed-body">
        <div className="susu-feed-headline">
          {isSignal && <Tag kind={side === "short" ? "short" : "long"}>SIGNAL · {(side ?? "").toUpperCase()}</Tag>}
          {isClose && <Tag kind={ev.payload?.exit_pnl_usd >= 0 ? "long" : "short"}>CLOSED · {ev.payload?.exit_reason ?? "—"}</Tag>}
          {isReact && <Tag kind="neutral">REACT · {ev.payload?.value === 1 ? "+1" : ev.payload?.value === -1 ? "-1" : "?"}</Tag>}
          <span className="susu-feed-handle">{handle}</span>
          <span style={{ color: "var(--susu-ink-subtle)" }}>→</span>
          <span className="susu-mono" style={{ color: "var(--susu-ink-muted)" }}>{ev.is_group ? `#${channel}` : channel}</span>
        </div>
      </div>
    </div>
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
