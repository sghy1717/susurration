// Risk caps page — read-only view of the daemon-side knobs that decide
// whether your agent acts on a peer's signal at all (min size factor,
// conv threshold), how often it talks (rate limit), and what it's allowed
// to push (dry-run, allowed-tools). Source of truth lives in
// ~/.susu/agent-config.json on the user's machine — daemon pings the
// snapshot up every 30 min via /identity/daemon-ping, server keeps it
// in identities.daemon_state_* columns. v2 dashboard reads it back from
// /daemon/state.

import { Shell } from "./Shell";
import { useDaemonState } from "./hooks";
import { Eyebrow, SectionTitle, Tag, ReadOnlyFootnote } from "./components";
import { useLang } from "../i18n";

export function RiskPage() {
  return (
    <Shell pageLabel="v2.page.risk">
      <RiskBody />
    </Shell>
  );
}

function RiskBody() {
  const { t } = useLang();
  const { data: d } = useDaemonState();

  const filterRows: Array<[string, React.ReactNode, string]> = [
    [
      t("v2.risk.row.minSize"),
      d?.min_size_factor != null ? d.min_size_factor.toFixed(2) : "—",
      t("v2.risk.hint.minSize"),
    ],
    [
      t("v2.risk.row.conv"),
      d?.conv_threshold != null ? d.conv_threshold.toFixed(2) : "—",
      t("v2.risk.hint.conv"),
    ],
  ];

  const executionRows: Array<[string, React.ReactNode, string]> = [
    [
      t("v2.risk.row.execMode"),
      d?.execution_mode
        ? <Tag kind={d.execution_mode === "live" ? "live" : "paper"}>{d.execution_mode.toUpperCase()}</Tag>
        : <span style={{ color: "var(--susu-ink-subtle)" }}>—</span>,
      t("v2.risk.hint.execMode"),
    ],
    [
      t("v2.risk.row.broker"),
      d?.broker_connected ? t("v2.risk.bool.yes") : <span style={{ color: "var(--susu-ink-subtle)" }}>{t("v2.risk.bool.no")}</span>,
      t("v2.risk.hint.broker"),
    ],
  ];

  // Render `intro` with a {file} placeholder swapped for a <code> chunk.
  // We split on the placeholder so the translation can move the variable
  // freely without breaking JSX.
  const introTpl = t("v2.risk.intro", { file: "%%FILE%%" });
  const [introBefore, introAfter = ""] = introTpl.split("%%FILE%%");

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>{t("v2.risk.eyebrow")}</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>
          {t("v2.risk.title")}
        </h1>
        <p style={{
          marginTop: "var(--susu-s-3)", maxWidth: 720,
          color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)", fontSize: 12,
          lineHeight: 1.6,
        }}>
          {introBefore}
          <code>~/.susu/agent-config.json</code>
          {introAfter}
        </p>
      </div>

      <div className="susu-grid-11">
        <section className="susu-section">
          <SectionTitle>{t("v2.risk.sec.filter")}</SectionTitle>
          <RiskList rows={filterRows} />
        </section>
        <section className="susu-section">
          <SectionTitle>{t("v2.risk.sec.execution")}</SectionTitle>
          <RiskList rows={executionRows} />
        </section>
      </div>

      <ReadOnlyFootnote />
    </>
  );
}

function RiskList({ rows }: { rows: Array<[string, React.ReactNode, string]> }) {
  return (
    <div className="susu-panel" style={{ padding: 0 }}>
      {rows.map(([label, value, hint]) => (
        <div key={label} style={{
          padding: "var(--susu-s-4)",
          borderBottom: "1px solid var(--susu-hairline)",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontFamily: "var(--susu-mono)", fontSize: 13,
          }}>
            <span style={{ color: "var(--susu-ink)" }}>{label}</span>
            <span style={{ color: "var(--susu-ink)", textAlign: "right" }}>{value}</span>
          </div>
          <div style={{
            marginTop: "var(--susu-s-2)",
            fontSize: 11, color: "var(--susu-ink-subtle)", lineHeight: 1.5,
          }}>
            {hint}
          </div>
        </div>
      ))}
    </div>
  );
}
