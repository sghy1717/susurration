// Signal feed page — full event stream with SSE live updates.

import { useMemo, useState, useEffect } from "react";
import { Shell } from "./Shell";
import {
  useSignalFeed, useFeedSSE, useBookSnapshot,
  useRecentDecisions, useWhoAmI, useAllPositions,
  formatPnl,
  type FeedItem, type RecentDecision, type Position,
} from "./hooks";
import {
  Eyebrow, Tag, formatClock, formatRelative,
} from "./components";
import { ownReactionsBySignalId } from "./feedModel";
import { useLang } from "../i18n";

// 2026-05-18 ADR remove-platform-paternalism follow-up (A) — feed flow is
// protocol-layer events (signal / reaction) only. Position state changes
// are application-layer (server writes them atomically inside
// /signals/:id/accept; no `position_opened` / `position_closed` event is
// emitted to the feed). The previous "opened" / "closed" filters were
// therefore dead chips that always counted 0. Removed. See
// `feedback_susurration_platform_not_paternalist.md` — protocol layer
// stays scene-agnostic; application data lives in Overview / BookPage.
type Filter = "all" | "signals" | "react_plus" | "react_minus";

// Server stores reaction value as the string "+1" or "-1" (set by mcp-adapter
// + cli). v2 originally compared against number 1 / -1 which always returned
// false → counters frozen at 0 even when events poured in. Normalise here.
function reactionPolarity(payload: any): "plus" | "minus" | null {
  const v = payload?.value;
  if (v === 1 || v === "+1" || v === "1") return "plus";
  if (v === -1 || v === "-1") return "minus";
  return null;
}

export function FeedPage() {
  const { t } = useLang();
  // Phase 18.2-w perf — bootstrap with 50 rows for fast first paint
  // (~80ms server + small parse), then on-demand "Load older" pulls
  // a deeper window.
  const [limit, setLimit] = useState(50);
  const { data: feed, loading } = useSignalFeed(limit);
  const sse = useFeedSSE(feed?.signals ?? []);
  const { data: snapshot } = useBookSnapshot();
  // 2026-05-18 H review (#3 方案 A) — pull caller's decision trace +
  // identity so the feed row can show "your agent: ACCEPT · used [...] ·
  // <latency> · $<cost>" as a sub-row under each signal. Caller-bound
  // ACL keeps these private to the viewer.
  const { data: decisionsResp } = useRecentDecisions(100);
  const { data: me } = useWhoAmI();
  const { data: positionsResp } = useAllPositions("all", 200);
  const myAddress = me?.address ?? null;

  const events = sse.events;
  const [filter, setFilter] = useState<Filter>("all");
  const since24h = useMemo(() => Date.now() - 24 * 3600 * 1000, []);
  const recent24h = useMemo(
    () => events.filter(e => new Date(e.created_at).getTime() >= since24h),
    [events, since24h],
  );

  const counts = useMemo(() => ({
    all: recent24h.length,
    signals: recent24h.filter(e => e.kind === "signal").length,
    react_plus: recent24h.filter(e => e.kind === "reaction" && reactionPolarity(e.payload) === "plus").length,
    react_minus: recent24h.filter(e => e.kind === "reaction" && reactionPolarity(e.payload) === "minus").length,
  }), [recent24h]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "signals":     return events.filter(e => e.kind === "signal");
      case "react_plus":  return events.filter(e => e.kind === "reaction" && reactionPolarity(e.payload) === "plus");
      case "react_minus": return events.filter(e => e.kind === "reaction" && reactionPolarity(e.payload) === "minus");
      default:            return events;
    }
  }, [events, filter]);

  // ── 2026-05-18 H review enrichment maps ────────────────────────────
  // #3: caller's agent decision indexed by signal_id (joined from
  // /daemon_decisions/mine — local-only data, caller-bound).
  const decisionsBySignalId = useMemo(() => {
    const m = new Map<string, RecentDecision>();
    for (const d of decisionsResp?.decisions ?? []) {
      if (d.signal_id) m.set(d.signal_id, d);
    }
    return m;
  }, [decisionsResp]);

  // #3: caller's OWN reaction on each signal (lets the sub-row show
  // verdict ACCEPT / REJECT / NO_REACT). Multiple peers may react on the
  // same signal — we want the viewer's own verdict, not anyone else's.
  const myReactionsBySignalId = useMemo(() => {
    return ownReactionsBySignalId(events, myAddress);
  }, [events, myAddress]);

  // 2026-05-18 Haze ask — feed row right column shows the position size
  // your agent actually took (or "no open" if it didn't). Index positions
  // by signal_id once so FeedRow lookup is O(1).
  const positionBySignalId = useMemo(() => {
    const m = new Map<string, Position>();
    for (const p of positionsResp?.positions ?? []) {
      if (p.signal_id) m.set(p.signal_id, p);
    }
    return m;
  }, [positionsResp]);

  // #2: fanout-key dedup. /api/signals/feed verified empirically (5/18)
  // returns *different* signal_id per channel for the same fan-out push —
  // server creates one signals row per channel target. So pure
  // signal_id dedup never fires. We instead key on
  // (from_address, token, direction, ts-bucket-2s): same sender pushing
  // same token+direction inside 2s is virtually always one fan-out, never
  // two independent signals. Conservative bucket avoids merging genuine
  // back-to-back pushes. Long-term TODO: server-side fanout_id field.
  const fanoutKey = (e: FeedItem): string => {
    const ts = Math.floor(new Date(e.created_at).getTime() / 2000);
    const token = e.payload?.token ?? e.payload?.symbol ?? "";
    const direction = e.payload?.direction ?? e.payload?.side ?? "";
    return `${e.from_address ?? ""}|${token}|${direction}|${ts}`;
  };

  // #2: aggregate channels per fanout-key (NOT signal_id — see above).
  // Lets a single deduped row render `channels: #ASHSHSHS, DM`.
  const signalChannelsByFanout = useMemo(() => {
    const m = new Map<string, Array<{ name: string | null; is_group: boolean }>>();
    for (const e of events) {
      if (e.kind === "signal") {
        const k = fanoutKey(e);
        const arr = m.get(k) ?? [];
        const chKey = `${e.channel_name ?? ""}|${e.is_group ?? false}`;
        if (!arr.some(c => `${c.name ?? ""}|${c.is_group}` === chKey)) {
          arr.push({ name: e.channel_name ?? null, is_group: e.is_group ?? false });
        }
        m.set(k, arr);
      }
    }
    return m;
  }, [events]);

  // #2: dedup by fanout-key. Events arrive newest-first so first occurrence
  // wins. Reactions stay 1-to-1 (each is its own event).
  const dedupedFiltered = useMemo(() => {
    const seen = new Set<string>();
    return filtered.filter(e => {
      if (e.kind === "signal") {
        const k = fanoutKey(e);
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    });
  }, [filtered]);

  const byPeer = useMemo(() => {
    const m = new Map<string, { username: string | null; count: number }>();
    for (const e of recent24h) {
      const key = e.from_username ?? e.from_address ?? "system";
      const cur = m.get(key) ?? { username: e.from_username ?? null, count: 0 };
      cur.count += 1;
      m.set(key, cur);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6);
  }, [recent24h]);

  return (
    <Shell
      pageLabel="v2.page.feed"
      topbarAux={
        <>
          <span>{t("v2.feed.streaming", { n: counts.all })}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: sse.status === "open" ? "var(--susu-pos)" : "var(--susu-warn)" }}>
            {t("v2.feed.sse", { status: sse.status })}
          </span>
        </>
      }
    >
      <div style={{ marginBottom: "var(--susu-s-5)" }}>
        <Eyebrow>{t("v2.feed.eyebrow")}</Eyebrow>
        <h1 className="susu-h2" style={{ marginTop: "var(--susu-s-2)" }}>{t("v2.feed.h1")}</h1>
        <p className="susu-body" style={{ marginTop: "var(--susu-s-2)", maxWidth: "56ch" }}>
          {t("v2.feed.intro")}
        </p>
      </div>

      <div className="susu-grid-feed">
        <div>
          <div className="susu-panel">
            <div className="filter-bar" style={{
              display: "flex", flexWrap: "wrap", gap: "var(--susu-s-2)",
              padding: "var(--susu-s-3) var(--susu-s-4)",
              borderBottom: "1px solid var(--susu-hairline)",
              alignItems: "center",
            }}>
              <Chip on={filter === "all"}        onClick={() => setFilter("all")}>{t("v2.feed.chip.all")} <Count>{counts.all}</Count></Chip>
              <Chip on={filter === "signals"}    onClick={() => setFilter("signals")}>{t("v2.feed.chip.signals")} <Count>{counts.signals}</Count></Chip>
              <Chip on={filter === "react_plus"} onClick={() => setFilter("react_plus")}>{t("v2.feed.chip.plus")} <Count>{counts.react_plus}</Count></Chip>
              <Chip on={filter === "react_minus"}onClick={() => setFilter("react_minus")}>{t("v2.feed.chip.minus")} <Count>{counts.react_minus}</Count></Chip>
              {/* "Opened" / "Closed" chips removed 2026-05-18: feed flow is
                  signal/reaction only; position lifecycle lives in Overview
                  KPI + BookPage. Future ADR may add client-side synthesis. */}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)" }}>{t("v2.feed.last24h")}</span>
            </div>
            {filtered.length === 0 ? (
              loading ? (
                <>{Array.from({ length: 6 }).map((_, i) => <FeedSkeletonRow key={i} />)}</>
              ) : (
                <div className="susu-empty">{t("v2.feed.empty")}</div>
              )
            ) : (
              <>
                {dedupedFiltered.slice(0, 100).map((ev, i) => {
                  const sid = ev.kind === "signal" ? ev.signal_id : null;
                  const decision = sid ? decisionsBySignalId.get(sid) : undefined;
                  const myReaction = sid ? myReactionsBySignalId.get(sid) : undefined;
                  // channels lookup uses fanout-key, not signal_id (5/18 verified
                  // server gives different signal_id per fan-out target).
                  const channels = ev.kind === "signal"
                    ? signalChannelsByFanout.get(fanoutKey(ev))
                    : undefined;
                  const position = sid ? positionBySignalId.get(sid) : undefined;
                  return (
                    <FeedRow
                      key={(ev.signal_id ?? ev.reaction_id ?? "") + ":" + ev.created_at + ":" + i}
                      ev={ev}
                      decision={decision}
                      myReaction={myReaction}
                      channels={channels}
                      position={position}
                    />
                  );
                })}
                {filter === "all" && limit < 200 && feed && feed.signals.length >= limit && (
                  <div style={{ display: "flex", justifyContent: "center", padding: "var(--susu-s-4)" }}>
                    <button
                      className="susu-btn susu-btn-ghost"
                      onClick={() => setLimit(200)}
                    >
                      {t("v2.feed.loadOlder")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <aside>
          <SummaryRail snapshot={snapshot} counts={counts} />
          <ByPeerRail rows={byPeer} />
        </aside>
      </div>
    </Shell>
  );
}

function Chip({ children, on, onClick }: { children: React.ReactNode; on?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`susu-btn susu-btn-sm${on ? "" : " susu-btn-ghost"}`} style={{ fontWeight: 500 }}>
      {children}
    </button>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return <span style={{ marginLeft: 4, color: "var(--susu-ink-subtle)", fontSize: 10 }}>{children}</span>;
}

function FeedRow({
  ev, decision, myReaction, channels, position,
}: {
  ev: FeedItem;
  decision?: RecentDecision;
  myReaction?: FeedItem;
  channels?: Array<{ name: string | null; is_group: boolean }>;
  position?: Position;
}) {
  const side = ev.payload?.side ?? ev.payload?.direction;
  const isSignal = ev.kind === "signal";
  const isReaction = ev.kind === "reaction";
  const isClose = ev.kind === "close" || ev.kind === "close_paper";
  const isOpen = ev.kind === "open" || ev.kind === "open_paper";

  const handle = ev.from_username
    ? `@${ev.from_username}`
    : ev.from_address
      ? `${ev.from_address.slice(0, 6)}…`
      : "system";

  // 2026-05-18 H review (#2 + 漏 #3) — when the same signal_id fans out
  // to multiple channels, FeedPage aggregates them in `channels` and we
  // render the full set here (`#ASHSHSHS, DM`). For non-signal rows
  // (reactions, etc.) fall back to the single channel on the event.
  const channelList: Array<{ name: string | null; is_group: boolean }> =
    isSignal && channels && channels.length > 0
      ? channels
      : [{ name: ev.channel_name ?? null, is_group: ev.is_group ?? false }];

  const tag = isSignal ? <Tag kind={side === "short" ? "short" : "long"}>SIGNAL · {(side ?? "?").toUpperCase()}</Tag>
            : isClose ? <Tag kind={ev.payload?.exit_pnl_usd >= 0 ? "long" : "short"}>CLOSED · {ev.payload?.exit_reason ?? "—"}</Tag>
            : isOpen ? <Tag kind="neutral">OPENED</Tag>
            : isReaction ? (() => { const pol = reactionPolarity(ev.payload); return <Tag kind={pol === "plus" ? "long" : pol === "minus" ? "short" : "neutral"}>REACT · {pol === "plus" ? "+1" : pol === "minus" ? "-1" : "?"}</Tag>; })()
            : <Tag kind="neutral">{ev.kind}</Tag>;

  // 2026-05-18 Haze ask — every signal row should show position taken
  // (or "no open" if your agent passed). isSignal: right column = position
  // status. isClose: right column = pnl. Else: collapse (auto → 0px).
  const showThirdCol = (isClose && ev.payload?.exit_pnl_usd != null)
                    || isSignal;

  // 2026-05-18 H review (#3 方案 A) — sub-row attaches your agent's
  // verdict to signal rows so feed reads as a full timeline (signal →
  // your agent's call) instead of stranded protocol events.
  const showAgentSubRow = isSignal && (decision || myReaction);

  return (
    <div className="susu-feed-row" style={{ gridTemplateColumns: showThirdCol ? "110px 1fr auto" : "110px 1fr" }}>
      <div className="susu-feed-time">
        {formatClock(ev.created_at)}
        <div style={{ fontSize: 9, color: "var(--susu-ink-faint)", marginTop: 2 }}>{formatRelative(ev.created_at)}</div>
      </div>
      <div className="susu-feed-body">
        <div className="susu-feed-headline">
          {tag}
          <span className="susu-feed-handle">{handle}</span>
          <span style={{ color: "var(--susu-ink-subtle)" }}>→</span>
          <ChannelList channels={channelList} />
        </div>
        <Payload payload={ev.payload} kind={ev.kind} />
        {showAgentSubRow && (
          <AgentDecisionSubRow decision={decision} myReaction={myReaction} />
        )}
      </div>
      {isClose && ev.payload?.exit_pnl_usd != null && (
        <div style={{ fontFamily: "var(--susu-mono)", fontSize: 12, color: "var(--susu-ink-subtle)" }}>
          <div style={{ color: ev.payload.exit_pnl_usd >= 0 ? "var(--susu-pos)" : "var(--susu-neg)", marginBottom: 4 }}>
            {formatPnl(ev.payload.exit_pnl_usd)}
            {ev.payload.exit_pnl_pct != null && ` (${ev.payload.exit_pnl_pct >= 0 ? "+" : ""}${(ev.payload.exit_pnl_pct * 100).toFixed(1)}%)`}
          </div>
        </div>
      )}
      {isSignal && (
        <PositionBadge position={position} myReaction={myReaction} />
      )}
    </div>
  );
}

// 2026-05-18 Haze ask — top-right chip on every signal showing the
// position your agent took ("$30,000") or "no open" if it passed. Three
// states:
//   - position present       → green `$X,XXX` (agent accepted + sized)
//   - myReaction === -1      → muted "不开仓 (REJECT)"
//   - no position, no -1     → muted "不开仓"
// This is the one-glance answer to "what did my agent do with this signal".
function PositionBadge({
  position, myReaction,
}: {
  position?: Position;
  myReaction?: FeedItem;
}) {
  const isReject = myReaction && reactionPolarity(myReaction.payload) === "minus";
  if (position && position.position_usd != null) {
    return (
      <div style={{
        fontFamily: "var(--susu-mono)", fontSize: 13, fontWeight: 600,
        color: "var(--susu-pos)",
        whiteSpace: "nowrap",
        paddingTop: 2,
        textAlign: "right",
      }}>
        ${Number(position.position_usd).toLocaleString("en-US", { maximumFractionDigits: 0 })}
        <div style={{
          fontSize: 9, fontWeight: 400,
          color: "var(--susu-ink-subtle)",
          marginTop: 2,
        }}>
          开仓
        </div>
      </div>
    );
  }
  return (
    <div style={{
      fontFamily: "var(--susu-mono)", fontSize: 11,
      color: "var(--susu-ink-subtle)",
      whiteSpace: "nowrap",
      paddingTop: 2,
      textAlign: "right",
    }}>
      不开仓
      {isReject && (
        <div style={{ fontSize: 9, marginTop: 2, color: "var(--susu-ink-faint)" }}>
          REJECT
        </div>
      )}
    </div>
  );
}

// 2026-05-18 H review (#3 视觉打磨) — channel pill with icon. group → `#`,
// DM-like (null name or non-group) → `✉`. Keeps a single visual language
// for channels so a glance distinguishes group vs DM without reading.
function ChannelList({ channels }: { channels: Array<{ name: string | null; is_group: boolean }> }) {
  return (
    <span className="susu-mono" style={{
      color: "var(--susu-ink-muted)",
      display: "inline-flex", flexWrap: "wrap", alignItems: "baseline",
      gap: 4,
    }}>
      {channels.map((c, i) => {
        const label = c.is_group && c.name ? c.name : (c.name ?? "DM");
        const prefix = c.is_group ? "#" : "✉";
        return (
          <span key={`${c.name ?? ""}|${c.is_group}`} style={{ display: "inline-flex", alignItems: "baseline", gap: 2 }}>
            {i > 0 && <span style={{ color: "var(--susu-ink-subtle)", marginRight: 2 }}>,</span>}
            <span style={{ color: "var(--susu-ink-subtle)", fontSize: 10 }}>{prefix}</span>
            <span>{label}</span>
          </span>
        );
      })}
    </span>
  );
}

// 2026-05-18 H review (#3 方案 A) — caller-only sub-row attached below a
// signal showing the verdict your agent reached (ACCEPT / REJECT / no
// reaction even though daemon dispatched), the tools it called, the
// wall-clock latency, and the per-event cost. Reasoning summary expands
// inline on click. ALL data is local-only (caller-bound by
// daemon_decisions ACL); peers never see this row.
function AgentDecisionSubRow({
  decision, myReaction,
}: {
  decision?: RecentDecision;
  myReaction?: FeedItem;
}) {
  const [expanded, setExpanded] = useState(false);

  // Verdict comes from the caller's own reaction (if any). Daemon-only
  // dispatch (no reaction emitted) still counts as activity worth
  // surfacing — "DISPATCHED" tells the user "agent ran but stayed silent".
  let verdictLabel = "DISPATCHED";
  let verdictColor = "var(--susu-ink-muted)";
  if (myReaction) {
    const pol = reactionPolarity(myReaction.payload);
    if (pol === "plus") {
      verdictLabel = "ACCEPT";
      verdictColor = "var(--susu-pos)";
    } else if (pol === "minus") {
      verdictLabel = "REJECT";
      verdictColor = "var(--susu-neg)";
    }
  }

  const tools = decision?.tools_used ?? [];
  // Collapse duplicate tool names. Read 4× shows as "Read×4" rather than
  // 4 entries. Cap at 6 to avoid the row blowing out horizontally.
  const toolCount = new Map<string, number>();
  for (const t of tools) toolCount.set(t.name, (toolCount.get(t.name) ?? 0) + 1);
  const toolList = Array.from(toolCount.entries())
    .slice(0, 6)
    .map(([name, n]) => n > 1 ? `${name}×${n}` : name);

  const latencyMs = decision?.latency_ms;
  // 2026-05-18 Haze decision — cost ($0.30 per claude invocation) hidden
  // from sub-row to avoid user cost anxiety. The number still lives in
  // daemon_decisions table for users who want it via DaemonPage, but the
  // feed shouldn't surface it on every signal. Latency stays (useful
  // perf signal; not anxiety-inducing).
  const reasoning = decision?.reasoning_summary ?? null;
  const hasReasoning = !!reasoning;

  return (
    <div
      style={{
        marginTop: "var(--susu-s-2)",
        paddingTop: "var(--susu-s-2)",
        borderTop: "1px dashed var(--susu-hairline)",
        fontFamily: "var(--susu-mono)",
        fontSize: 11,
        color: "var(--susu-ink-muted)",
      }}
    >
      <div
        onClick={hasReasoning ? () => setExpanded(e => !e) : undefined}
        style={{
          cursor: hasReasoning ? "pointer" : "default",
          display: "flex", flexWrap: "wrap", alignItems: "baseline",
          gap: "var(--susu-s-3)",
        }}
      >
        <span style={{ color: "var(--susu-ink-subtle)" }}>↳ your agent:</span>
        <span style={{ color: verdictColor, fontWeight: 500 }}>{verdictLabel}</span>
        {toolList.length > 0 && (
          <span style={{ color: "var(--susu-ink-subtle)" }}>
            used <span style={{ color: "var(--susu-ink-muted)" }}>[{toolList.join(", ")}]</span>
          </span>
        )}
        {latencyMs != null && (
          <span style={{ color: "var(--susu-ink-subtle)" }}>{(latencyMs / 1000).toFixed(1)}s</span>
        )}
        {hasReasoning && (
          <span style={{ color: "var(--susu-accent, var(--susu-ink-muted))", fontSize: 10, marginLeft: "auto" }}>
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>
      {expanded && hasReasoning && (
        <div style={{
          marginTop: 6,
          paddingLeft: 14,
          color: "var(--susu-ink-subtle)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {reasoning}
        </div>
      )}
      <div style={{
        marginTop: 4,
        fontSize: 9,
        color: "var(--susu-ink-faint)",
        fontStyle: "italic",
      }}>
        local-only · caller-bound · never pushed to peers
      </div>
    </div>
  );
}

// Phase 18.2-w perf — skeleton rows shown while the very first
// /signals/feed bootstrap is in flight. Once that returns, all subsequent
// polls keep the previous data on screen, so this only appears on landing.
function FeedSkeletonRow() {
  return (
    <div
      className="susu-feed-row"
      style={{
        gridTemplateColumns: "120px 1fr",
        borderBottom: "1px solid var(--susu-hairline)",
        padding: "var(--susu-s-3) var(--susu-s-4)",
      }}
      aria-hidden
    >
      <div style={{
        height: 14, width: 80, borderRadius: 4,
        background: "var(--susu-surface-2)",
        opacity: 0.55,
      }} className="susu-tick-pulse" />
      <div>
        <div style={{
          height: 14, width: "62%", borderRadius: 4,
          background: "var(--susu-surface-2)",
          opacity: 0.45,
          marginBottom: 8,
        }} className="susu-tick-pulse" />
        <div style={{
          height: 12, width: "38%", borderRadius: 4,
          background: "var(--susu-surface-2)",
          opacity: 0.35,
        }} className="susu-tick-pulse" />
      </div>
    </div>
  );
}

// 2026-05-18 H review (#1 — info hierarchy rewrite). Replaces the previous
// flat `Object.entries.slice(0, 8) + PayloadRow` block, which gave every
// field equal visual weight and forced the agent reader to scan 8 mono
// lines for any field they actually cared about. Now signal-shaped payloads
// render three tiers:
//   Tier 1 — DECISION CORE: token · direction × leverage · confidence (inline)
//   Tier 2 — RISK PARAMS:   entry / SL / TP1..3 / position_pct (grid)
//   Tier 3 — STRATEGY DETAIL: horizon / reason / source_id / raw_signal /
//             any unrecognized fields, collapsed by default behind a toggle
// Non-signal payloads (reactions, future event kinds) fall through to the
// legacy flat render so we don't lose info for those shapes.
function Payload({ payload, kind }: { payload: any; kind?: string }) {
  if (payload == null) return null;
  // Signal-shape detection — must have at least token + direction. Reactions
  // (value / size_factor / note) and other payload shapes go to the
  // fallback so we don't accidentally hide their content under a "展开"
  // button.
  const isSignalShape =
    kind === "signal" &&
    payload &&
    typeof payload === "object" &&
    (payload.token || payload.symbol) &&
    (payload.direction || payload.side);

  if (isSignalShape) {
    return <SignalPayload payload={payload} />;
  }

  // Fallback: legacy flat k/v rendering for reactions / unknown payload shapes.
  let entries: [string, any][];
  if (typeof payload === "object" && !Array.isArray(payload)) {
    entries = Object.entries(payload).slice(0, 8);
  } else {
    entries = [["payload", payload]];
  }
  if (entries.length === 0) return null;
  return (
    <div
      className="susu-feed-payload"
      style={{
        maxHeight: 240,
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {entries.map(([k, v]) => (
        <PayloadRow key={k} k={k} v={v} />
      ))}
    </div>
  );
}

// Tier-rendered signal payload — see Payload() comment. The decision /
// risk / detail split is what makes a signal card legible in one glance
// instead of an 8-line mono scan.
function SignalPayload({ payload }: { payload: any }) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState(false);

  const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const pick = (k: string) => payload[k] ?? meta[k];

  // ── Tier 1: decision core ──────────────────────────────────────────
  const token = pick("token") ?? pick("symbol");
  const direction = pick("direction") ?? pick("side");
  const leverage = pick("leverage");
  const confidence = payload.confidence;

  // ── Tier 2: risk params (only render rows that have data) ─────────
  const riskRows: Array<[string, React.ReactNode]> = [];
  const entry = pick("entry_price");
  const sl = pick("stop_loss");
  const tp1 = meta.take_profit_1 ?? pick("take_profit");
  const tp2 = meta.take_profit_2;
  const tp3 = meta.take_profit_3;
  const positionPct = pick("position_pct");
  // 2026-05-18 — GS pro signals now carry absolute position_usd ($30k for
  // 100k account × 30%). Show it alongside the relative position_pct so
  // receiver agents (and humans) immediately see the suggested size.
  const positionUsd = pick("position_usd");
  const fmtNum = (v: any) => typeof v === "number" ? (Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5)) : String(v);
  const fmtUsd = (v: any) => typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : String(v);
  if (entry != null)        riskRows.push(["entry",       fmtNum(entry)]);
  if (sl != null)           riskRows.push(["stop_loss",   fmtNum(sl)]);
  if (tp1 != null)          riskRows.push(["tp1",         fmtNum(tp1)]);
  if (tp2 != null)          riskRows.push(["tp2",         fmtNum(tp2)]);
  if (tp3 != null)          riskRows.push(["tp3",         fmtNum(tp3)]);
  if (positionPct != null)  riskRows.push(["position_pct", `${positionPct}%`]);
  if (positionUsd != null)  riskRows.push(["position_usd", fmtUsd(positionUsd)]);

  // ── Tier 3: strategy detail (collapsed by default) ─────────────────
  // Surface horizon / reason / source_id directly; raw_signal stays as
  // a JSON block since it's a strategy-specific dump. Any unrecognized
  // top-level keys land here too so we don't silently hide them.
  const handled = new Set(["token", "symbol", "direction", "side", "confidence", "metadata"]);
  const detailEntries: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(payload)) {
    if (handled.has(k)) continue;
    detailEntries.push([k, v]);
  }
  // metadata internals worth surfacing inside the collapsed section
  const metaExtras: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(meta)) {
    if (["leverage", "stop_loss", "take_profit", "take_profit_1", "take_profit_2", "take_profit_3",
         "position_pct", "entry_price"].includes(k)) continue;
    metaExtras.push([k, v]);
  }

  return (
    <div className="susu-feed-payload" style={{ overflowX: "hidden" }}>
      {/* Tier 1 — decision core */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--susu-s-3)",
        marginBottom: "var(--susu-s-2)",
        fontFamily: "var(--susu-mono)",
      }}>
        {token && (
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--susu-ink)" }}>{String(token)}</span>
        )}
        {direction && (
          <span style={{
            fontSize: 11,
            color: String(direction).toLowerCase() === "short" ? "var(--susu-neg)" : "var(--susu-pos)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>
            {String(direction)}{leverage != null ? ` × ${leverage}` : ""}
          </span>
        )}
        {confidence != null && (
          <span style={{ fontSize: 11, color: "var(--susu-ink-subtle)" }}>
            conf <span style={{ color: "var(--susu-ink-muted)" }}>{Number(confidence).toFixed(2)}</span>
          </span>
        )}
      </div>

      {/* Tier 2 — risk params */}
      {riskRows.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: "var(--susu-s-2) var(--susu-s-3)",
          padding: "var(--susu-s-2) 0",
          fontFamily: "var(--susu-mono)", fontSize: 11,
          borderTop: "1px solid var(--susu-hairline)",
          borderBottom: detailEntries.length > 0 || metaExtras.length > 0 ? "1px solid var(--susu-hairline)" : "none",
        }}>
          {riskRows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "var(--susu-ink-subtle)", fontSize: 10 }}>{k}</span>
              <span style={{ color: "var(--susu-ink-muted)" }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tier 3 — strategy detail (collapsed) */}
      {(detailEntries.length > 0 || metaExtras.length > 0) && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              marginTop: "var(--susu-s-2)",
              border: "none",
              background: "transparent",
              color: "var(--susu-accent, var(--susu-ink-muted))",
              cursor: "pointer",
              font: "inherit",
              fontSize: 11,
              fontFamily: "var(--susu-mono)",
              padding: 0,
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {expanded ? t("v2.feed.showLess") : t("v2.feed.showMore")}
          </button>
          {expanded && (
            <div style={{
              marginTop: "var(--susu-s-2)",
              maxHeight: 360,
              overflowY: "auto",
            }}>
              {detailEntries.map(([k, v]) => <PayloadRow key={k} k={k} v={v} />)}
              {metaExtras.map(([k, v]) => <PayloadRow key={`meta.${k}`} k={`metadata.${k}`} v={v} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PayloadRow({ k, v }: { k: string; v: any }) {
  const { t } = useLang();
  const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
  const isLong = rendered.length > 120;
  const [expanded, setExpanded] = useState(false);
  const display = !isLong || expanded
    ? rendered
    : rendered.slice(0, 120) + "…";
  return (
    // 2026-05-18 H review 漏 #5 — `word-break: break-word` was splitting
    // long numbers / hex addresses mid-digit ("0.0000022...". | "0x1234..."
    // wrapped at "00000" / "12"). `overflow-wrap: anywhere` lets the
    // browser break at safer spots (whitespace, end of token) and only
    // falls back to mid-token when there's no whitespace at all.
    <div style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
      <span className="k">{k}:</span>{" "}
      <span className={typeof v === "number" ? "n" : "s"}>{display}</span>
      {isLong && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            marginLeft: 6,
            border: "none",
            background: "transparent",
            color: "var(--susu-accent)",
            cursor: "pointer",
            font: "inherit",
            padding: 0,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          {expanded ? t("v2.feed.showLess") : t("v2.feed.showMore")}
        </button>
      )}
    </div>
  );
}

function SummaryRail({ snapshot, counts }: { snapshot: any; counts: any }) {
  const { t } = useLang();
  return (
    <section className="susu-section">
      <div className="susu-section-head">
        <div className="susu-section-title">{t("v2.feed.rail.24hBook")}</div>
      </div>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        <SummaryLine label={t("v2.feed.rail.received")} value={snapshot?.signals_received_24h ?? counts.signals} />
        <SummaryLine label={t("v2.feed.rail.accepted")} value={snapshot?.accepted_24h ?? "—"} />
        <SummaryLine label={t("v2.feed.rail.plus")} value={counts.react_plus} />
        <SummaryLine label={t("v2.feed.rail.minus")} value={counts.react_minus} />
        {/* "Opened" / "Closed" rows removed 2026-05-18 (same reason as the
            filter chips above): position lifecycle isn't a feed event;
            see Overview KPI + BookPage for live position counts. */}
      </div>
    </section>
  );
}

function SummaryLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "var(--susu-s-2) var(--susu-s-3)",
      fontFamily: "var(--susu-mono)", fontSize: 12,
    }}>
      <span style={{ color: "var(--susu-ink-subtle)" }}>{label}</span>
      <span style={{ color: "var(--susu-ink)" }}>{value}</span>
    </div>
  );
}

function ByPeerRail({ rows }: { rows: [string, { username: string | null; count: number }][] }) {
  const { t } = useLang();
  return (
    <section className="susu-section">
      <div className="susu-section-head">
        <div className="susu-section-title">{t("v2.feed.rail.byPeer")}</div>
      </div>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {rows.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-3)" }}>{t("v2.feed.rail.byPeer.empty")}</div>
        ) : rows.map(([k, r]) => (
          <SummaryLine
            key={k}
            label={r.username ? `@${r.username}` : `${k.slice(0, 6)}…`}
            value={r.count}
          />
        ))}
      </div>
    </section>
  );
}
