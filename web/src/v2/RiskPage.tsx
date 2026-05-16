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

export function RiskPage() {
  return (
    <Shell pageLabel="risk caps">
      <RiskBody />
    </Shell>
  );
}

function RiskBody() {
  const { data: d } = useDaemonState();

  const filterRows: Array<[string, React.ReactNode, string]> = [
    [
      "min size factor",
      d?.min_size_factor != null ? d.min_size_factor.toFixed(2) : "—",
      "Lower bound on conviction (size_factor) the agent must report when accepting a signal — below this, the daemon refuses to open a paper position even if the agent agreed. Default 0.5.",
    ],
    [
      "conv threshold",
      d?.conv_threshold != null ? d.conv_threshold.toFixed(2) : "—",
      "Minimum signal-level confidence (0–1) the daemon will dispatch on. Cheaper than rate-limiting your IDE-agent: low-confidence signals never reach the agent at all.",
    ],
  ];

  const executionRows: Array<[string, React.ReactNode, string]> = [
    [
      "execution mode",
      d?.execution_mode
        ? <Tag kind={d.execution_mode === "live" ? "live" : "paper"}>{d.execution_mode.toUpperCase()}</Tag>
        : <span style={{ color: "var(--susu-ink-subtle)" }}>—</span>,
      "paper: positions live only in susurration's simulator. live: the agent has a broker MCP wired up and is reporting real broker fills back via susu_position_close.",
    ],
    [
      "broker connected",
      d?.broker_connected ? "yes" : <span style={{ color: "var(--susu-ink-subtle)" }}>no</span>,
      "Whether the agent has a broker tool in its allowed-tools list. v0.0.x deliberately reports false; agent's broker MCP is opt-in via the user's CLAUDE.md.",
    ],
  ];

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>agent · risk caps</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>
          Risk caps
        </h1>
        <p style={{
          marginTop: "var(--susu-s-3)", maxWidth: 720,
          color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)", fontSize: 12,
          lineHeight: 1.6,
        }}>
          Read-only mirror of your daemon's <code>~/.susu/agent-config.json</code>.
          Changes happen on your machine, not here — edit the file and the
          daemon will push the new snapshot on its next 30-min ping. (Wanting
          inline editing? Phase 18.3+; for now this is honest about being a
          mirror.)
        </p>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--susu-s-6)",
      }}>
        <section className="susu-section">
          <SectionTitle>Signal filtering</SectionTitle>
          <RiskList rows={filterRows} />
        </section>
        <section className="susu-section">
          <SectionTitle>Execution</SectionTitle>
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
