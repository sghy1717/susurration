// Book page — full positions ledger (open + closed) with mode filter and
// realised PnL aggregates. Same Shell as Overview; this page is the
// "trade history" surface — anyone digging into why balance moved comes
// here.

import { useMemo, useState } from "react";
import { Shell } from "./Shell";
import {
  useBookSnapshot, useOpenPositions, useBookEquity,
  type Position, type ModeFilter,
  formatMoney, formatPnl, formatPercent,
} from "./hooks";
import {
  Eyebrow, SectionTitle, Tag, KpiStrip,
  EquityCurve, ReadOnlyFootnote, ModeFilterPill, ModeBadge,
} from "./components";
import { api } from "../api";
import { useEffect } from "react";

interface PositionsResp { positions: Position[]; }

function useAllPositions(mode: ModeFilter) {
  // Closed-status only; combined with open via useOpenPositions in the
  // caller. The endpoint supports status=all but we split so each list
  // can paginate independently without coupling.
  const [closed, setClosed] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = mode === "all" ? "status=closed&limit=500" : `status=closed&mode=${mode}&limit=500`;
    api<PositionsResp>({ path: `/positions/mine?${q}` })
      .then(r => { if (!cancelled) { setClosed(r.positions); setLoading(false); }})
      .catch(() => { if (!cancelled) { setClosed([]); setLoading(false); }});
    return () => { cancelled = true; };
  }, [mode]);
  return { closed, loading };
}

export function BookPage() {
  return (
    <Shell pageLabel="book">
      <BookBody />
    </Shell>
  );
}

function BookBody() {
  const [mode, setMode] = useState<ModeFilter>("all");
  const { data: snapshot } = useBookSnapshot(mode);
  const { data: openResp } = useOpenPositions(mode);
  const { data: equity } = useBookEquity(30, mode === "live" ? "live" : "paper");
  const { closed } = useAllPositions(mode);

  const open = openResp?.positions ?? [];
  const initial = snapshot?.initial_balance_usd ?? 100_000;
  const realized = snapshot?.realized_pnl_total ?? 0;
  const wins = snapshot?.wins ?? 0;
  const losses = snapshot?.losses ?? 0;
  const breakeven = snapshot?.break_even ?? 0;
  const closedCount = snapshot?.closed_count ?? 0;

  // Sort closed by closed_at desc (server should already, but defensive).
  const closedSorted = useMemo(() =>
    [...closed].sort((a, b) =>
      (b.closed_at ?? "").localeCompare(a.closed_at ?? "")
    ), [closed]
  );

  // Aggregate by exit_reason for a quick read of how trades are closing.
  const byReason = useMemo(() => {
    const m: Record<string, { count: number; pnl: number }> = {};
    for (const p of closedSorted) {
      const r = p.exit_reason ?? "—";
      const slot = m[r] ?? (m[r] = { count: 0, pnl: 0 });
      slot.count++;
      slot.pnl += p.exit_pnl_usd ?? 0;
    }
    return Object.entries(m).sort((a, b) => b[1].count - a[1].count);
  }, [closedSorted]);

  return (
    <>
      <div style={{
        marginBottom: "var(--susu-s-6)",
        display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--susu-s-4)",
      }}>
        <div>
          <Eyebrow>book · {mode === "all" ? "paper + live" : mode}</Eyebrow>
          <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>
            {closedCount} closed · {open.length} open
          </h1>
        </div>
        <ModeFilterPill value={mode} onChange={setMode} />
      </div>

      <KpiStrip cells={[
        {
          label: "Realised PnL",
          value: formatPnl(realized),
          metaTone: realized >= 0 ? "pos" : "neg",
          meta: `${formatPercent(realized / initial)} of initial`,
        },
        {
          label: "Win rate",
          value: closedCount > 0 ? `${Math.round((wins / closedCount) * 100)}%` : "—",
          meta: `${wins}W · ${losses}L${breakeven > 0 ? ` · ${breakeven}BE` : ""}`,
        },
        {
          label: "Avg PnL / trade",
          value: closedCount > 0 ? formatPnl(realized / closedCount) : "—",
          meta: closedCount > 0 ? `${closedCount} trades` : "no trades yet",
        },
        {
          label: "Initial balance",
          value: formatMoney(initial),
          meta: `current ${formatMoney(initial + realized)}`,
        },
      ]} />

      <div style={{
        marginTop: "var(--susu-s-8)",
        display: "grid", gridTemplateColumns: "2fr 1fr", gap: "var(--susu-s-6)",
      }}>
        <div>
          <section className="susu-section">
            <SectionTitle aux={`${closedSorted.length} rows`}>Closed trades</SectionTitle>
            <div className="susu-panel">
              {closedSorted.length === 0 ? (
                <div className="susu-empty">No closed trades yet for this mode.</div>
              ) : (
                <table className="susu-table">
                  <thead>
                    <tr>
                      <th>Closed</th>
                      <th>Asset</th>
                      <th>Mode</th>
                      <th>Side</th>
                      <th>Reason</th>
                      <th className="num">Entry → Exit</th>
                      <th className="num">PnL %</th>
                      <th className="num">PnL $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedSorted.slice(0, 200).map(p => (
                      <ClosedRow key={p.position_id} p={p} />
                    ))}
                  </tbody>
                </table>
              )}
              {closedSorted.length > 200 && (
                <div style={{ padding: "var(--susu-s-4)", color: "var(--susu-ink-subtle)", fontSize: 11, textAlign: "center" }}>
                  showing latest 200 of {closedSorted.length} — older trades visible via API
                </div>
              )}
            </div>
          </section>

          <section className="susu-section">
            <SectionTitle aux={`${equity?.points.length ?? 0} days · ${mode}`}>Equity curve</SectionTitle>
            {equity && <EquityCurve points={equity.points} initialBalance={initial} />}
          </section>
        </div>

        <div>
          <section className="susu-section">
            <SectionTitle>Exit reasons</SectionTitle>
            <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
              {byReason.length === 0 ? (
                <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>
                  No closed trades.
                </div>
              ) : byReason.map(([reason, { count, pnl }]) => (
                <div key={reason} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  padding: "var(--susu-s-2) var(--susu-s-3)",
                  fontFamily: "var(--susu-mono)", fontSize: 12,
                }}>
                  <span style={{ color: "var(--susu-ink)" }}>{reason}</span>
                  <span style={{ display: "flex", gap: "var(--susu-s-3)" }}>
                    <span style={{ color: "var(--susu-ink-subtle)" }}>{count}</span>
                    <span style={{
                      color: pnl >= 0 ? "var(--susu-pos)" : "var(--susu-neg)",
                      width: 70, textAlign: "right",
                    }}>
                      {formatPnl(pnl)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="susu-section">
            <SectionTitle>Open positions</SectionTitle>
            <div className="susu-panel" style={{ padding: "var(--susu-s-3)" }}>
              {open.length === 0 ? (
                <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)" }}>
                  No open positions for this mode.
                </div>
              ) : open.map(p => (
                <div key={p.position_id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  padding: "var(--susu-s-2) var(--susu-s-3)",
                  fontFamily: "var(--susu-mono)", fontSize: 12,
                }}>
                  <span style={{ display: "flex", gap: "var(--susu-s-2)", alignItems: "baseline" }}>
                    <strong style={{ color: "var(--susu-ink)" }}>{p.token}</strong>
                    <ModeBadge mode={p.mode ?? "paper"} />
                  </span>
                  <Tag kind={p.direction === "long" ? "long" : "short"}>{p.direction.toUpperCase()} {p.leverage}x</Tag>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <ReadOnlyFootnote />
    </>
  );
}

function ClosedRow({ p }: { p: Position }) {
  const pnlPct = p.exit_pnl_pct ?? 0;
  const pnlUsd = p.exit_pnl_usd ?? 0;
  const closedAt = p.closed_at ? new Date(p.closed_at) : null;
  return (
    <tr>
      <td className="susu-mono" style={{ fontSize: 11, color: "var(--susu-ink-subtle)" }}>
        {closedAt ? closedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—"}
      </td>
      <td><strong className="susu-mono" style={{ color: "var(--susu-ink)" }}>{p.token}</strong></td>
      <td><ModeBadge mode={p.mode ?? "paper"} /></td>
      <td><Tag kind={p.direction === "long" ? "long" : "short"}>{p.direction.toUpperCase()}</Tag></td>
      <td style={{ fontSize: 11, color: "var(--susu-ink-muted)" }}>{p.exit_reason ?? "—"}</td>
      <td className="num">
        {p.entry_price.toLocaleString(undefined, { maximumFractionDigits: 4 })}
        {" → "}
        {p.exit_price?.toLocaleString(undefined, { maximumFractionDigits: 4 }) ?? "—"}
      </td>
      <td className="num" style={{ color: pnlPct >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
      </td>
      <td className="num" style={{ color: pnlUsd >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}>
        {pnlUsd >= 0 ? "+" : ""}${pnlUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </td>
    </tr>
  );
}
