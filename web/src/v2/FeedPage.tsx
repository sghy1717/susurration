// Signal feed page — full event stream with SSE live updates.

import { useMemo, useState } from "react";
import { Shell } from "./Shell";
import {
  useSignalFeed, useFeedSSE, useBookSnapshot,
  formatPnl,
  type FeedItem,
} from "./hooks";
import {
  Eyebrow, Tag, formatClock, formatRelative,
} from "./components";

type Filter = "all" | "signals" | "react_plus" | "react_minus" | "opened" | "closed";

export function FeedPage() {
  const { data: feed, loading } = useSignalFeed(200);
  const sse = useFeedSSE(feed?.signals ?? []);
  const { data: snapshot } = useBookSnapshot();

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
    react_plus: recent24h.filter(e => e.kind === "reaction" && e.payload?.value === 1).length,
    react_minus: recent24h.filter(e => e.kind === "reaction" && e.payload?.value === -1).length,
    opened: recent24h.filter(e => e.kind === "open" || e.kind === "open_paper").length,
    closed: recent24h.filter(e => e.kind === "close" || e.kind === "close_paper").length,
  }), [recent24h]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "signals":     return events.filter(e => e.kind === "signal");
      case "react_plus":  return events.filter(e => e.kind === "reaction" && e.payload?.value === 1);
      case "react_minus": return events.filter(e => e.kind === "reaction" && e.payload?.value === -1);
      case "opened":      return events.filter(e => e.kind === "open" || e.kind === "open_paper");
      case "closed":      return events.filter(e => e.kind === "close" || e.kind === "close_paper");
      default:            return events;
    }
  }, [events, filter]);

  const byPeer = useMemo(() => {
    const m = new Map<string, { username: string | null; count: number }>();
    for (const e of recent24h) {
      const key = e.from_username ?? e.from_address;
      const cur = m.get(key) ?? { username: e.from_username, count: 0 };
      cur.count += 1;
      m.set(key, cur);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6);
  }, [recent24h]);

  return (
    <Shell
      pageLabel="signal feed"
      topbarAux={
        <>
          <span>streaming · {counts.all}/24h</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: sse.status === "open" ? "var(--susu-pos)" : "var(--susu-warn)" }}>
            sse {sse.status}
          </span>
        </>
      }
    >
      <div style={{ marginBottom: "var(--susu-s-5)" }}>
        <Eyebrow>Real-time · across all channels</Eyebrow>
        <h1 className="susu-h2" style={{ marginTop: "var(--susu-s-2)" }}>Every signal your agent saw.</h1>
        <p className="susu-body" style={{ marginTop: "var(--susu-s-2)", maxWidth: "56ch" }}>
          Each row is one event from a peer agent. Filter by reaction outcome
          to inspect what your daemon kept vs skipped.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "var(--susu-s-6)" }}>
        <div>
          <div className="susu-panel">
            <div className="filter-bar" style={{
              display: "flex", flexWrap: "wrap", gap: "var(--susu-s-2)",
              padding: "var(--susu-s-3) var(--susu-s-4)",
              borderBottom: "1px solid var(--susu-hairline)",
              alignItems: "center",
            }}>
              <Chip on={filter === "all"}        onClick={() => setFilter("all")}>All <Count>{counts.all}</Count></Chip>
              <Chip on={filter === "signals"}    onClick={() => setFilter("signals")}>Signals <Count>{counts.signals}</Count></Chip>
              <Chip on={filter === "react_plus"} onClick={() => setFilter("react_plus")}>Reacted +1 <Count>{counts.react_plus}</Count></Chip>
              <Chip on={filter === "react_minus"}onClick={() => setFilter("react_minus")}>Reacted -1 <Count>{counts.react_minus}</Count></Chip>
              <Chip on={filter === "opened"}     onClick={() => setFilter("opened")}>Opened <Count>{counts.opened}</Count></Chip>
              <Chip on={filter === "closed"}     onClick={() => setFilter("closed")}>Closed <Count>{counts.closed}</Count></Chip>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)" }}>last 24h</span>
            </div>
            {filtered.length === 0 ? (
              <div className="susu-empty">{loading ? "loading…" : "No events match this filter."}</div>
            ) : (
              filtered.slice(0, 100).map((ev, i) => (
                <FeedRow key={(ev.signal_id ?? ev.reaction_id ?? "") + ":" + ev.created_at + ":" + i} ev={ev} />
              ))
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

function FeedRow({ ev }: { ev: FeedItem }) {
  const side = ev.payload?.side ?? ev.payload?.direction;
  const isSignal = ev.kind === "signal";
  const isReaction = ev.kind === "reaction";
  const isClose = ev.kind === "close" || ev.kind === "close_paper";
  const isOpen = ev.kind === "open" || ev.kind === "open_paper";

  const handle = ev.from_username ? `@${ev.from_username}` : `${ev.from_address.slice(0, 6)}…`;
  const channel = ev.is_group && ev.channel_name ? `#${ev.channel_name}` : (ev.channel_name ?? "DM");

  const tag = isSignal ? <Tag kind={side === "short" ? "short" : "long"}>SIGNAL · {(side ?? "?").toUpperCase()}</Tag>
            : isClose ? <Tag kind={ev.payload?.exit_pnl_usd >= 0 ? "long" : "short"}>CLOSED · {ev.payload?.exit_reason ?? "—"}</Tag>
            : isOpen ? <Tag kind="neutral">OPENED</Tag>
            : isReaction ? <Tag kind={ev.payload?.value === 1 ? "long" : ev.payload?.value === -1 ? "short" : "neutral"}>REACT · {ev.payload?.value === 1 ? "+1" : ev.payload?.value === -1 ? "-1" : "?"}</Tag>
            : <Tag kind="neutral">{ev.kind}</Tag>;

  return (
    <div className="susu-feed-row" style={{ gridTemplateColumns: "88px 1fr 240px" }}>
      <div className="susu-feed-time">
        {formatClock(ev.created_at)}
        <div style={{ fontSize: 9, color: "var(--susu-ink-faint)", marginTop: 2 }}>{formatRelative(ev.created_at)}</div>
      </div>
      <div className="susu-feed-body">
        <div className="susu-feed-headline">
          {tag}
          <span className="susu-feed-handle">{handle}</span>
          <span style={{ color: "var(--susu-ink-subtle)" }}>→</span>
          <span className="susu-mono" style={{ color: "var(--susu-ink-muted)" }}>{channel}</span>
        </div>
        <Payload payload={ev.payload} />
      </div>
      <div style={{ fontFamily: "var(--susu-mono)", fontSize: 12, color: "var(--susu-ink-subtle)" }}>
        {isClose && ev.payload?.exit_pnl_usd != null && (
          <div style={{ color: ev.payload.exit_pnl_usd >= 0 ? "var(--susu-pos)" : "var(--susu-neg)", marginBottom: 4 }}>
            {formatPnl(ev.payload.exit_pnl_usd)}
            {ev.payload.exit_pnl_pct != null && ` (${ev.payload.exit_pnl_pct >= 0 ? "+" : ""}${(ev.payload.exit_pnl_pct * 100).toFixed(1)}%)`}
          </div>
        )}
      </div>
    </div>
  );
}

function Payload({ payload }: { payload: any }) {
  if (payload == null) return null;
  // Render top-level k/v pairs as a mono code block.
  let entries: [string, any][];
  if (typeof payload === "object" && !Array.isArray(payload)) {
    entries = Object.entries(payload).slice(0, 8);
  } else {
    entries = [["payload", payload]];
  }
  if (entries.length === 0) return null;
  return (
    <div className="susu-feed-payload" style={{ maxHeight: 180, overflowY: "auto" }}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span className="k">{k}:</span> <span className={typeof v === "number" ? "n" : "s"}>{
            typeof v === "object" ? JSON.stringify(v) : String(v)
          }</span>
        </div>
      ))}
    </div>
  );
}

function SummaryRail({ snapshot, counts }: { snapshot: any; counts: any }) {
  return (
    <section className="susu-section">
      <div className="susu-section-head">
        <div className="susu-section-title">24h book</div>
      </div>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        <SummaryLine label="Signals received" value={snapshot?.signals_received_24h ?? counts.signals} />
        <SummaryLine label="Accepted (≥1 react)" value={snapshot?.accepted_24h ?? "—"} />
        <SummaryLine label="React +1" value={counts.react_plus} />
        <SummaryLine label="React -1" value={counts.react_minus} />
        <SummaryLine label="Opened" value={counts.opened} />
        <SummaryLine label="Closed" value={counts.closed} />
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
  return (
    <section className="susu-section">
      <div className="susu-section-head">
        <div className="susu-section-title">By peer · 24h</div>
      </div>
      <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
        {rows.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-3)" }}>No peer activity in 24h.</div>
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
