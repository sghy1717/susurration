// Daemon page — full agent state detail. The Overview already has a
// compressed AgentStatePanel; this page is the deep version: version
// info, ping cadence, runner config snapshot, recent decision telemetry.
// Useful for the user when something looks off ("why hasn't my agent
// reacted") — one place to glance at all the daemon-side knobs.

import { useState } from "react";
import { Shell, useNow } from "./Shell";
import {
  useDaemonState, useDaemonUpgrade, useWhoAmI,
  useRecentDecisions, type RecentDecision,
  durationStr,
} from "./hooks";
import {
  Eyebrow, SectionTitle, StatusDot, Tag, ReadOnlyFootnote, formatClock,
} from "./components";
import { useLang } from "../i18n";

// 2026-05-18 G review #5 — was a file-local duplicate of hooks.ts's
// useRecentDecisions. Removed; reuse the shared hook + RecentDecision
// interface. Type alias retained for the local DecisionRow renderer.
type DaemonDecisionRow = RecentDecision;

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
  // 2026-05-18 G #5 — using shared hook from hooks.ts. New shape is
  // { data: { decisions: [...] } | undefined }; unwrap once here.
  const { data: decisionsResp } = useRecentDecisions(30);
  const decisions = decisionsResp?.decisions ?? null;
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
  const [expanded, setExpanded] = useState(false);
  // 2026-05-18 ADR §What we add #9 — show that the agent actually used
  // local Read / Skill / MCP when deciding. We collapse duplicate calls
  // to the same tool name (an agent may call Read 4 times in one turn);
  // the count goes in parens. The full input list is in the expansion.
  const tools = Array.isArray(d.tools_used) ? d.tools_used : [];
  const toolSummary: Array<{ name: string; count: number }> = [];
  for (const t of tools) {
    const last = toolSummary[toolSummary.length - 1];
    if (last && last.name === t.name) last.count += 1;
    else toolSummary.push({ name: t.name, count: 1 });
  }
  const denials = Array.isArray(d.permission_denials) ? d.permission_denials : [];
  const hasDetails = tools.length > 0 || denials.length > 0 || d.reasoning_summary || d.cost_usd != null;
  return (
    <div style={{ borderBottom: "1px solid var(--susu-hairline)" }}>
      <div
        onClick={() => hasDetails && setExpanded(v => !v)}
        style={{
          display: "grid",
          gridTemplateColumns: "auto auto 1fr auto auto",
          gap: "var(--susu-s-3)",
          padding: "var(--susu-s-2) var(--susu-s-3)",
          fontFamily: "var(--susu-mono)", fontSize: 11,
          cursor: hasDetails ? "pointer" : "default",
        }}
      >
        <span style={{ color: "var(--susu-ink-subtle)" }}>
          {ts.toISOString().slice(11, 19)}
        </span>
        <Tag kind={isError ? "short" : "neutral"}>{d.kind}</Tag>
        <span style={{ color: "var(--susu-ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.error_type ?? d.event_kind ?? "—"}
          {d.context?.runner ? ` · ${d.context.runner}` : ""}
          {toolSummary.length > 0 ? (
            <span style={{ color: "var(--susu-accent, var(--susu-ink))", marginLeft: 8 }}>
              · {toolSummary.map(t => `${t.name}${t.count > 1 ? `×${t.count}` : ""}`).join(", ")}
            </span>
          ) : null}
        </span>
        <span style={{ color: "var(--susu-ink-subtle)", whiteSpace: "nowrap" }}>
          {(() => {
            // Defensive: backend NUMERIC parser in db.ts gives number, but a
            // stale localStorage snapshot from an older bundle may still hold
            // string. Coerce + sanity-check rather than calling .toFixed on
            // an unknown type — the 2026-05-19 whitescreen happened exactly
            // here.
            if (d.cost_usd == null) return "";
            const n = typeof d.cost_usd === "number" ? d.cost_usd : Number(d.cost_usd);
            return Number.isFinite(n) ? `$${n.toFixed(4)}` : "";
          })()}
        </span>
        <span style={{ color: "var(--susu-ink-subtle)", whiteSpace: "nowrap" }}>
          {d.latency_ms != null ? `${d.latency_ms}ms` : ""}
        </span>
      </div>
      {expanded && hasDetails && (
        <div style={{
          padding: "var(--susu-s-2) var(--susu-s-4)",
          fontFamily: "var(--susu-mono)", fontSize: 10.5,
          background: "var(--susu-panel-subtle, rgba(0,0,0,0.02))",
          color: "var(--susu-ink-muted)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {tools.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: "var(--susu-ink-subtle)" }}>tools (in order): </span>
              {tools.map((t, i) => (
                <div key={i} style={{ marginLeft: 12, marginTop: 2 }}>
                  · <strong style={{ color: "var(--susu-ink)" }}>{t.name}</strong>
                  {t.input ? <span style={{ marginLeft: 6 }}>{
                    JSON.stringify(t.input).length > 200
                      ? JSON.stringify(t.input).slice(0, 197) + "…"
                      : JSON.stringify(t.input)
                  }</span> : null}
                </div>
              ))}
            </div>
          )}
          {denials.length > 0 && (
            <div style={{ marginBottom: 6, color: "var(--susu-warn, var(--susu-ink-muted))" }}>
              <span>permission denials:</span> {denials.length} call{denials.length === 1 ? "" : "s"} denied by your IDE.
            </div>
          )}
          {d.reasoning_summary && (
            <div style={{ marginTop: 6 }}>
              <span style={{ color: "var(--susu-ink-subtle)" }}>reasoning: </span>
              {d.reasoning_summary}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--susu-ink-subtle)" }}>
            (local-only · caller-bound · never pushed to peers)
          </div>
        </div>
      )}
    </div>
  );
}
