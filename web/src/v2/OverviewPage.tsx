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
import { useLang } from "../i18n";

export function OverviewPage() {
  return (
    <Shell pageLabel="v2.page.overview">
      <OverviewBody />
    </Shell>
  );
}

function OverviewBody() {
  const { t } = useLang();
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
      <div className="susu-page-hero">
        <div>
          <Eyebrow>{t("v2.ov.eyebrow")}</Eyebrow>
          {/* Phase 18.2-w UX pass — reserve two lines of height so the
              hero doesn't reflow between 1 and 2 lines as the live PnL
              digit count changes. */}
          <h1
            className="susu-h1"
            style={{
              marginTop: "var(--susu-s-2)",
              minHeight: "2.4em",
            }}
          >
            {t("v2.ov.hero.pre")}
            <TickValue
              value={totalPnl}
              format={v => formatPnl(typeof v === "number" ? v : Number(v))}
              style={{ color: totalPnl >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}
            />
            {t("v2.ov.hero.post")}
          </h1>
        </div>
        <div className="susu-page-hero-actions">
          <ModeFilterPill value={mode} onChange={setMode} />
          <div style={{ display: "flex", gap: "var(--susu-s-2)" }}>
            <button className="susu-btn">{t("v2.ov.range.21d")}</button>
            <button className="susu-btn susu-btn-ghost">{t("v2.ov.range.7d")}</button>
            <button className="susu-btn susu-btn-ghost">{t("v2.ov.range.24h")}</button>
          </div>
        </div>
      </div>

      <KpiStrip cells={[
        {
          label: t("v2.ov.kpi.balance"),
          value: <TickValue value={balance} format={v => formatMoney(typeof v === "number" ? v : Number(v))} />,
          meta: <TickValue value={pctVsInitial} format={v => formatPercent((typeof v === "number" ? v : Number(v)) / 100)} /> ,
          metaTone: totalPnl >= 0 ? "pos" : "neg",
        },
        {
          label: t("v2.ov.kpi.winRate"),
          value: snapshot?.win_rate != null ? `${Math.round(snapshot.win_rate * 100)}%` : "—",
          meta: snapshot
            ? t("v2.ov.kpi.winRateMeta", { wins: snapshot.wins, losses: snapshot.losses, closed: snapshot.closed_count })
            : (snapLoading ? t("v2.ov.kpi.loading") : "—"),
        },
        {
          label: t("v2.ov.kpi.signalsReceived"),
          value: snapshot?.signals_received_24h ?? "—",
          meta: snapshot ? (
            <>react +1 · <TickValue value={snapshot.accepted_24h} /> {snapshot.accept_rate_24h != null ? `(${Math.round(snapshot.accept_rate_24h * 100)}%)` : ""}</>
          ) : "—",
        },
        {
          label: t("v2.ov.kpi.openPositions"),
          value: positions.length,
          meta: <>{t("v2.ov.kpi.unrealized")} <TickValue value={unrealized} format={v => formatPnl(typeof v === "number" ? v : Number(v))} style={{ color: unrealized >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }} /></>,
        },
      ]} />

      <div className="susu-grid-21" style={{ marginTop: "var(--susu-s-8)" }}>
        <div>
          <section className="susu-section">
            <SectionTitle aux={
              t("v2.ov.aux.openCount", { n: positions.length })
              + (mode !== "all" ? ` · ${mode}` : "")
              + (positions[0]?.opened_at ? t("v2.ov.aux.markedAt", { time: formatClock(new Date().toISOString()) }) : "")
            }>
              {t("v2.ov.sec.openPositions")}
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
                  {t("v2.ov.empty.openPositions")}
                </div>
              ) : (
                <table className="susu-table" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr>
                      <th>{t("v2.ov.table.asset")}</th>
                      <th>{t("v2.ov.table.mode")}</th>
                      <th>{t("v2.ov.table.side")}</th>
                      <th>{t("v2.ov.table.from")}</th>
                      <th>{t("v2.ov.table.slMarkTp")}</th>
                      <th>{t("v2.ov.table.pnl")}</th>
                      <th>{t("v2.ov.table.duration")}</th>
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
              !equity ? t("v2.ov.aux.equityLoading")
              : mode === "all" ? t("v2.ov.aux.equityAll", { n: equity.points.length })
              : t("v2.ov.aux.equityOne", { mode, n: equity.points.length })
            }>
              {t("v2.ov.sec.equity")}
            </SectionTitle>
            {equity && (
              <EquityCurve
                points={equity.points}
                secondaryPoints={equitySecondary?.points}
                initialBalance={initial}
                primaryColor={mode === "live" ? "#f6c177" : "#34d399"}
                primaryLabel={mode === "all" ? t("v2.equity.legend.paper") : undefined}
              />
            )}
            {/* Phase 18.2-w (H P3b) — one-sentence prose summary so the
                page answers "what happened?" without anyone reading the
                chart. Generated from snapshot, not hand-written. */}
            {snapshot && <EquityNarrative snapshot={snapshot} />}
          </section>

          <section className="susu-section">
            <SectionTitle aux={<Link to="/v2/feed" className="susu-btn susu-btn-ghost susu-btn-sm">{t("v2.ov.btn.fullFeed")}</Link>}>
              {t("v2.ov.sec.recent")}
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
                <div className="susu-empty">{t("v2.ov.empty.recent")}</div>
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
  const { t } = useLang();
  const { wins, losses, break_even, closed_count, realized_pnl_total, initial_balance_usd } = snapshot;
  if (!closed_count) {
    return (
      <p style={{
        marginTop: "var(--susu-s-3)",
        fontFamily: "var(--susu-mono)", fontSize: 12, lineHeight: 1.6,
        color: "var(--susu-ink-subtle)",
        maxWidth: "60ch",
      }}>
        {t("v2.ov.narrative.noClosed")}
      </p>
    );
  }
  const pct = (realized_pnl_total / initial_balance_usd) * 100;
  const isUp = realized_pnl_total >= 0;
  // Use backend-computed win_rate (categorized denominator) instead of
  // recomputing wins/closed_count — closed_count includes PnL-pending rows
  // and would skew the narrative branch (e.g. read "rough" when truth is "drift").
  const winRate = snapshot.win_rate != null
    ? Math.round(snapshot.win_rate * 100)
    : Math.round((wins / Math.max(1, wins + losses + break_even)) * 100);
  const beClause = break_even > 0 ? t("v2.ov.narrative.be", { n: break_even }) : "";
  const trailing = isUp
    ? (winRate >= 60 ? t("v2.ov.narrative.drift") : t("v2.ov.narrative.mixed"))
    : (winRate >= 50 ? t("v2.ov.narrative.redOk") : t("v2.ov.narrative.rough"));
  return (
    <p style={{
      marginTop: "var(--susu-s-3)",
      fontFamily: "var(--susu-mono)", fontSize: 12, lineHeight: 1.6,
      color: "var(--susu-ink-subtle)",
      maxWidth: "60ch",
    }}>
      <strong style={{ color: "var(--susu-ink)", fontWeight: 500 }}>
        {wins} {t(wins === 1 ? "v2.ov.narrative.win.one" : "v2.ov.narrative.win.many")}, {losses} {t(losses === 1 ? "v2.ov.narrative.loss.one" : "v2.ov.narrative.loss.many")}{beClause}
      </strong>{" "}
      {t("v2.ov.narrative.across", { n: closed_count })}{" "}
      {t(closed_count === 1 ? "v2.ov.narrative.trade.one" : "v2.ov.narrative.trade.many")} ·{" "}
      <span style={{ color: isUp ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {isUp ? "+" : ""}{pct.toFixed(2)}%
      </span>{" "}
      {t("v2.ov.narrative.vsInitial")} {trailing}
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
      <td style={{
        fontFamily: "var(--susu-mono)",
        fontVariantNumeric: "tabular-nums",
        color: pnl == null ? "var(--susu-ink-subtle)" : pnl >= 0 ? "var(--susu-pos)" : "var(--susu-neg)",
      }}>
        {pnl == null ? "—" : (
          <TickValue value={pnl} format={v => formatPnl(typeof v === "number" ? v : Number(v))} />
        )}
      </td>
      <td style={{ fontFamily: "var(--susu-mono)", fontVariantNumeric: "tabular-nums" }}>
        {durationStr(p.opened_at, now)}
      </td>
    </tr>
  );
}

function AgentStatePanel() {
  const { t } = useLang();
  const { data: daemon } = useDaemonState();
  const now = useNow();
  if (!daemon) return null;

  const rows: Array<[string, React.ReactNode]> = [
    [t("v2.ov.agent.daemon"), daemon.status === "online" && daemon.started_at
      ? t("v2.ov.agent.onlineFor", { dur: durationStr(daemon.started_at, now) })
      : daemon.status],
    [t("v2.ov.agent.provider"), daemon.provider ?? "—"],
    [t("v2.ov.agent.execution"), daemon.execution_mode
      ? <Tag kind={daemon.execution_mode === "live" ? "live" : "paper"}>{daemon.execution_mode.toUpperCase()}</Tag>
      : <span style={{ color: "var(--susu-ink-subtle)" }}>—</span>],
    [t("v2.ov.agent.broker"), daemon.broker_connected ? t("v2.ov.agent.brokerConnected") : <span style={{ color: "var(--susu-ink-subtle)" }}>{t("v2.ov.agent.brokerNot")}</span>],
    [t("v2.ov.agent.conv"), daemon.conv_threshold != null ? daemon.conv_threshold.toFixed(2) : "—"],
    [t("v2.ov.agent.minSize"), daemon.min_size_factor != null ? daemon.min_size_factor.toFixed(2) : "—"],
    [t("v2.ov.agent.version"), daemon.version ? `v${daemon.version}` : "—"],
  ];

  return (
    <section className="susu-section">
      <SectionTitle>{t("v2.ov.sec.agentState")}</SectionTitle>
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
  const { t } = useLang();
  return (
    <section className="susu-section">
      <SectionTitle aux={<Link to="/v2/friends" className="susu-btn susu-btn-ghost susu-btn-sm">{t("v2.ov.btn.all")}</Link>}>
        {t("v2.ov.sec.topPeers")}
      </SectionTitle>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {peers.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>{t("v2.ov.empty.peers")}</div>
        ) : peers.slice(0, 6).map((p, i) => (
          <div key={p.address ?? i} style={{
            display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
            padding: "var(--susu-s-2) var(--susu-s-3)",
          }}>
            <Avatar seed={p.username ?? p.address} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="susu-mono" style={{ fontSize: 12 }}>{p.username ? `@${p.username}` : `${p.address?.slice(0, 6) ?? "—"}…`}</div>
              <div style={{ fontSize: 10, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
                {t("v2.ov.peer.signals", { n: p.signal_count })}
                {p.accept_rate != null ? t("v2.ov.peer.accept", { pct: Math.round(p.accept_rate * 100) }) : ""}
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
  const { t } = useLang();
  return (
    <section className="susu-section">
      <SectionTitle aux={t("v2.ov.aux.channels", { n: channels.length })}>{t("v2.ov.sec.channels")}</SectionTitle>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {channels.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>{t("v2.ov.empty.channels")}</div>
        ) : channels.slice(0, 8).map(c => (
          <div key={c.channel_id} style={{
            display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
            padding: "var(--susu-s-2) var(--susu-s-3)",
          }}>
            <div className="susu-avatar">#</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="susu-mono" style={{ fontSize: 12 }}>{c.name ?? c.channel_id.slice(0, 8)}</div>
              <div style={{ fontSize: 10, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
                {t("v2.ov.channel.members", { n: c.member_count })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
