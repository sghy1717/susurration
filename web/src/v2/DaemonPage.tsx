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
import { useLang } from "../i18n";

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
    <Shell pageLabel="v2.page.daemon">
      <DaemonBody />
    </Shell>
  );
}

function DaemonBody() {
  const { t } = useLang();
  const { data: daemon } = useDaemonState();
  const { data: me } = useWhoAmI();
  const upgrade = useDaemonUpgrade();
  const decisions = useRecentDecisions(30);
  const now = useNow();

  const upgradeInFlight = upgrade.state === "upgrading" || upgrade.state === "polling";
  const statusLabel = upgradeInFlight ? t("v2.shell.upgrading")
                    : daemon?.status === "online" ? t("v2.shell.status.online")
                    : daemon?.status === "stale" ? t("v2.shell.status.stale")
                    : daemon?.status === "never_seen" ? t("v2.shell.status.neverSeen")
                    : "—";

  const uptimeText = (() => {
    if (upgradeInFlight) return upgrade.state === "upgrading" ? t("v2.shell.uptime.upgrading") : t("v2.shell.uptime.restarting");
    if (!daemon) return "—";
    if (daemon.started_at) return durationStr(daemon.started_at, now);
    if (daemon.last_ping_at) return t("v2.daemon.lastPingAgo", { dur: durationStr(daemon.last_ping_at, now) });
    return "—";
  })();

  const rows: Array<[string, React.ReactNode]> = [
    [t("v2.daemon.row.status"), <span style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-2)" }}>
      <StatusDot kind={daemon?.status === "online" ? "live" : daemon?.status === "stale" ? "warn" : "idle"} />
      {statusLabel}
    </span>],
    [t("v2.daemon.row.uptime"), uptimeText],
    [t("v2.daemon.row.lastPing"), daemon?.last_ping_at ? formatClock(daemon.last_ping_at) + " UTC" : "—"],
    [t("v2.daemon.row.version"), daemon?.version ? `v${daemon.version}` : "—"],
    [t("v2.daemon.row.latestAvailable"), upgrade.latestVersion ? `v${upgrade.latestVersion}` : "—"],
    [t("v2.daemon.row.needsUpgrade"), upgrade.needsUpgrade ? t("v2.daemon.yes") : t("v2.daemon.no")],
    [t("v2.daemon.row.provider"), daemon?.provider ?? "—"],
    [t("v2.daemon.row.execMode"), daemon?.execution_mode
      ? <Tag kind={daemon.execution_mode === "live" ? "live" : "paper"}>{daemon.execution_mode.toUpperCase()}</Tag>
      : "—"],
    [t("v2.daemon.row.broker"), daemon?.broker_connected ? t("v2.daemon.yes") : t("v2.daemon.no")],
    [t("v2.daemon.row.conv"), daemon?.conv_threshold != null ? daemon.conv_threshold.toFixed(2) : "—"],
    [t("v2.daemon.row.minSize"), daemon?.min_size_factor != null ? daemon.min_size_factor.toFixed(2) : "—"],
    [t("v2.daemon.row.address"), me?.address ? <code style={{ fontSize: 11 }}>{me.address}</code> : "—"],
    [t("v2.daemon.row.handle"), me?.username ? `@${me.username}` : "—"],
  ];

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>{t("v2.daemon.eyebrow")}</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>{t("v2.daemon.title")}</h1>
      </div>

      <div className="susu-grid-11">
        <section className="susu-section">
          <SectionTitle>{t("v2.daemon.sec.snapshot")}</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
            {rows.map(([k, v], i) => (
              <div key={i} style={{
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
          <SectionTitle aux={decisions ? t("v2.daemon.aux.lastN", { n: decisions.length }) : t("v2.daemon.aux.loading")}>
            {t("v2.daemon.sec.dispatches")}
          </SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-3)", maxHeight: 540, overflow: "auto" }}>
            {!decisions ? (
              <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>{t("v2.daemon.loading")}</div>
            ) : decisions.length === 0 ? (
              <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>
                {t("v2.daemon.empty")}
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
