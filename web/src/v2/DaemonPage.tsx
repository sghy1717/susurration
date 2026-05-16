// Daemon page — full agent state detail. The Overview already has a
// compressed AgentStatePanel; this page is the deep version: version
// info, ping cadence, runner config snapshot, recent decision telemetry.
// Useful for the user when something looks off ("why hasn't my agent
// reacted") — one place to glance at all the daemon-side knobs.

import { useEffect, useState } from "react";
import { Shell, useNow } from "./Shell";
import {
  useDaemonState, useDaemonUpgrade, useWhoAmI,
  durationStr,
} from "./hooks";
import {
  Eyebrow, SectionTitle, StatusDot, Tag, ReadOnlyFootnote, formatClock,
} from "./components";
import { api } from "../api";

interface DaemonDecisionRow {
  decision_id: string;
  kind: string;
  event_kind: string | null;
  signal_id: string | null;
  channel_id: string | null;
  error_type: string | null;
  latency_ms: number | null;
  context: Record<string, string> | null;
  created_at: string;
}

function useRecentDecisions(limit: number = 20) {
  const [rows, setRows] = useState<DaemonDecisionRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchRows = () => {
      api<{ decisions: DaemonDecisionRow[] }>({ path: `/daemon_decisions/mine?limit=${limit}` })
        .then(r => { if (!cancelled) setRows(r.decisions); })
        .catch(() => { if (!cancelled) setRows([]); });
    };
    fetchRows();
    const id = setInterval(fetchRows, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [limit]);
  return rows;
}

export function DaemonPage() {
  return (
    <Shell pageLabel="daemon">
      <DaemonBody />
    </Shell>
  );
}

function DaemonBody() {
  const { data: daemon } = useDaemonState();
  const { data: me } = useWhoAmI();
  const upgrade = useDaemonUpgrade();
  const decisions = useRecentDecisions(30);
  const now = useNow();

  const upgradeInFlight = upgrade.state === "upgrading" || upgrade.state === "polling";
  const statusLabel = upgradeInFlight ? "upgrading"
                    : daemon?.status === "online" ? "online"
                    : daemon?.status === "stale" ? "stale"
                    : daemon?.status === "never_seen" ? "never seen"
                    : "—";

  const uptimeText = (() => {
    if (upgradeInFlight) return upgrade.state === "upgrading" ? "upgrading…" : "restarting…";
    if (!daemon) return "—";
    if (daemon.started_at) return durationStr(daemon.started_at, now);
    if (daemon.last_ping_at) return `last ping ${durationStr(daemon.last_ping_at, now)} ago`;
    return "—";
  })();

  const rows: Array<[string, React.ReactNode]> = [
    ["status", <span style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-2)" }}>
      <StatusDot kind={daemon?.status === "online" ? "live" : daemon?.status === "stale" ? "warn" : "idle"} />
      {statusLabel}
    </span>],
    ["uptime", uptimeText],
    ["last ping", daemon?.last_ping_at ? formatClock(daemon.last_ping_at) + " UTC" : "—"],
    ["version", daemon?.version ? `v${daemon.version}` : "—"],
    ["latest available", upgrade.latestVersion ? `v${upgrade.latestVersion}` : "—"],
    ["needs upgrade", upgrade.needsUpgrade ? "yes" : "no"],
    ["provider", daemon?.provider ?? "—"],
    ["execution mode", daemon?.execution_mode
      ? <Tag kind={daemon.execution_mode === "live" ? "live" : "paper"}>{daemon.execution_mode.toUpperCase()}</Tag>
      : "—"],
    ["broker connected", daemon?.broker_connected ? "yes" : "no"],
    ["conv threshold", daemon?.conv_threshold != null ? daemon.conv_threshold.toFixed(2) : "—"],
    ["min size factor", daemon?.min_size_factor != null ? daemon.min_size_factor.toFixed(2) : "—"],
    ["address", me?.address ? <code style={{ fontSize: 11 }}>{me.address}</code> : "—"],
    ["handle", me?.username ? `@${me.username}` : "—"],
  ];

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>agent · daemon</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>Daemon state</h1>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--susu-s-6)",
      }}>
        <section className="susu-section">
          <SectionTitle>Snapshot</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "var(--susu-s-2) var(--susu-s-3)",
                fontFamily: "var(--susu-mono)", fontSize: 12,
                borderBottom: "1px solid var(--susu-hairline)",
              }}>
                <span style={{ color: "var(--susu-ink-subtle)" }}>{k}</span>
                <span style={{ color: "var(--susu-ink)", textAlign: "right" }}>{v}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle aux={decisions ? `last ${decisions.length}` : "loading…"}>
            Recent dispatches
          </SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-3)", maxHeight: 540, overflow: "auto" }}>
            {!decisions ? (
              <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>loading…</div>
            ) : decisions.length === 0 ? (
              <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>
                No dispatches recorded yet — your daemon hasn't seen an actionable event.
              </div>
            ) : decisions.map(d => <DecisionRow key={d.decision_id} d={d} />)}
          </div>
        </section>
      </div>

      <ReadOnlyFootnote />
    </>
  );
}

function DecisionRow({ d }: { d: DaemonDecisionRow }) {
  const ts = new Date(d.created_at);
  const isError = d.kind === "error";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto auto 1fr auto",
      gap: "var(--susu-s-3)",
      padding: "var(--susu-s-2) var(--susu-s-3)",
      fontFamily: "var(--susu-mono)", fontSize: 11,
      borderBottom: "1px solid var(--susu-hairline)",
    }}>
      <span style={{ color: "var(--susu-ink-subtle)" }}>
        {ts.toISOString().slice(11, 19)}
      </span>
      <Tag kind={isError ? "short" : "neutral"}>{d.kind}</Tag>
      <span style={{ color: "var(--susu-ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.error_type ?? d.event_kind ?? "—"}
        {d.context?.runner ? ` · ${d.context.runner}` : ""}
      </span>
      <span style={{ color: "var(--susu-ink-subtle)", whiteSpace: "nowrap" }}>
        {d.latency_ms != null ? `${d.latency_ms}ms` : ""}
      </span>
    </div>
  );
}
