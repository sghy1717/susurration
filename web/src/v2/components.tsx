// Reusable components for the v2 dashboard.
// Token classes (susu-*) come from tokens.css imported at the page level.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// ── Brand wordmark ───────────────────────────────────────────────────────

export function Wordmark({ size = "lg" }: { size?: "xs" | "sm" | "lg" | "xl" }) {
  return (
    <span className={`susu-wordmark ${size}`}>
      susurration<span className="slash">/</span>
    </span>
  );
}

// ── Breathing status dot (defaults to "live"; pass kind for variants) ────

export function StatusDot({ kind = "live" }: { kind?: "live" | "idle" | "warn" }) {
  const cls = kind === "live" ? "susu-status-dot" : `susu-status-dot ${kind}`;
  return <span className={cls} />;
}

// ── Tag pill (semantic side / mode markers) ──────────────────────────────

export function Tag({
  kind,
  children,
}: {
  kind?: "long" | "short" | "paper" | "live" | "neutral";
  children: ReactNode;
}) {
  const klass = kind && kind !== "neutral" ? `susu-tag ${kind}` : "susu-tag";
  return <span className={klass}>{children}</span>;
}

// ── PAPER / LIVE pill shown in the topbar status group ───────────────────

export function ModePill({ mode }: { mode: "paper" | "live" | null }) {
  const label = mode ?? "—";
  const style: CSSProperties = {
    fontFamily: "var(--susu-mono)",
    fontSize: 10,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: mode === "live" ? "var(--susu-pos)" : "var(--susu-ink-subtle)",
    border: `1px solid ${mode === "live" ? "var(--susu-pos)" : "var(--susu-hairline)"}`,
    padding: "2px 7px",
    borderRadius: 4,
    background: mode === "live" ? "rgba(52, 211, 153, 0.06)" : "rgba(255,255,255,0.02)",
  };
  return <span style={style}>{label}</span>;
}

// ── TickValue — flashes up/down on change ────────────────────────────────

export function TickValue({
  value,
  format,
  className,
  style,
}: {
  value: number | string;
  format?: (v: number | string) => string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const lastNumRef = useRef<number | null>(null);
  const displayed = format ? format(value) : String(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cur = typeof value === "number" ? value : Number(value);
    const prev = lastNumRef.current;
    lastNumRef.current = Number.isFinite(cur) ? cur : null;
    if (prev === null || !Number.isFinite(cur) || cur === prev) return;
    el.classList.remove("up", "down");
    // Force reflow to restart the animation.
    void el.offsetWidth;
    el.classList.add(cur > prev ? "up" : "down");
  }, [value]);

  return (
    <span ref={ref} className={`susu-tick ${className ?? ""}`} style={style}>
      {displayed}
    </span>
  );
}

// ── KpiStrip — top-of-page metrics row ───────────────────────────────────

export interface KpiCellProps {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  metaTone?: "pos" | "neg" | "neutral";
}

export function KpiStrip({ cells }: { cells: KpiCellProps[] }) {
  return (
    <div className="susu-kpi-strip">
      {cells.map((c, i) => (
        <div className="susu-kpi" key={i}>
          <div className="susu-kpi-label">{c.label}</div>
          <div className="susu-kpi-value">{c.value}</div>
          {c.meta != null && (
            <div className={`susu-kpi-meta${c.metaTone && c.metaTone !== "neutral" ? ` ${c.metaTone}` : ""}`}>
              {c.meta}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Avatar — initial-letter + hashed bg ──────────────────────────────────

const AVATAR_PALETTE = [
  { bg: "#15393b", fg: "#34d399" },
  { bg: "#172131", fg: "#7ec5ff" },
  { bg: "#2d1f2e", fg: "#f0a4d6" },
  { bg: "#2a2517", fg: "#fbbf24" },
  { bg: "#1f2a18", fg: "#a3e635" },
  { bg: "#251a2d", fg: "#c084fc" },
  { bg: "#1c2e2f", fg: "#5eead4" },
];

function paletteIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_PALETTE.length;
}

export function Avatar({
  seed,
  letter,
  size = 28,
  round = false,
}: {
  seed: string;
  letter?: string;
  size?: number;
  round?: boolean;
}) {
  const palette = AVATAR_PALETTE[paletteIndex(seed)]!;
  const ch = (letter ?? seed.charAt(0) ?? "?").toUpperCase();
  return (
    <div
      className={`susu-avatar${round ? " round" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size < 24 ? 10 : size < 36 ? 11 : 14,
        background: palette.bg,
        color: palette.fg,
        flexShrink: 0,
      }}
    >
      {ch}
    </div>
  );
}

// ── Mode filter pill — paper / live / all toggle ─────────────────────────
//
// Phase 18.2 — Susurration's book now holds both paper positions (the built-
// in simulator) and live positions (real broker trades the agent executed and
// reported back). The dashboard needs to let the user see either book or
// both. We use a compact three-button pill that lives in the page header so
// every KPI on the page reacts when the user switches.

export type ModePillValue = "all" | "paper" | "live";

export function ModeFilterPill({
  value,
  onChange,
  size = "md",
}: {
  value: ModePillValue;
  onChange: (next: ModePillValue) => void;
  size?: "sm" | "md";
}) {
  const items: { v: ModePillValue; label: string; title: string }[] = [
    { v: "all", label: "ALL", title: "Both paper and live positions combined" },
    { v: "paper", label: "PAPER", title: "Susurration's built-in simulator" },
    { v: "live", label: "LIVE", title: "Real broker trades reported by the agent" },
  ];
  const padY = size === "sm" ? 4 : 6;
  const padX = size === "sm" ? 8 : 12;
  return (
    <div
      role="tablist"
      aria-label="Book mode filter"
      style={{
        display: "inline-flex",
        gap: 0,
        padding: 2,
        border: "1px solid var(--susu-border-soft)",
        borderRadius: 999,
        background: "var(--susu-surface-1)",
        fontFamily: "var(--susu-mono)",
        fontSize: size === "sm" ? 10 : 11,
        letterSpacing: "0.04em",
        userSelect: "none",
      }}
    >
      {items.map(({ v, label, title }) => {
        const active = value === v;
        return (
          <button
            key={v}
            role="tab"
            aria-selected={active}
            title={title}
            onClick={() => onChange(v)}
            style={{
              border: "none",
              background: active ? "var(--susu-accent)" : "transparent",
              color: active ? "var(--susu-bg)" : "var(--susu-ink-subtle)",
              padding: `${padY}px ${padX}px`,
              borderRadius: 999,
              fontFamily: "inherit",
              fontSize: "inherit",
              letterSpacing: "inherit",
              cursor: "pointer",
              transition: "background-color 160ms ease, color 160ms ease",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Upgrade banner — sticky top-center pill shown when daemon is behind ─
//
// Phase 18.2-w — v2 port of v0's UpgradeBanner. State machine lives in the
// useDaemonUpgrade hook; this component is presentation-only. Mounts in
// Shell so every v2 page surfaces it without explicit wiring.

import type { UpgradeStatus } from "./hooks";

export function UpgradeBanner({
  status,
  onDismiss,
}: {
  status: UpgradeStatus;
  onDismiss: () => void;
}) {
  if (!status.needsUpgrade) return null;

  const { state, error, currentVersion, latestVersion, triggerUpgrade } = status;

  // One button, one trigger. Lazy probe means the label can stay neutral
  // ("Upgrade") on idle — we only know whether this turns into a real
  // one-click or a clipboard copy after the user opts in. State labels
  // narrate after that decision.
  let buttonLabel: string;
  if (state === "upgrading")    buttonLabel = "Upgrading…";
  else if (state === "polling") buttonLabel = "Restarting daemon…";
  else if (state === "done")    buttonLabel = "✓ Upgraded";
  else if (state === "copied")  buttonLabel = "✓ Copied — paste in terminal";
  else if (state === "error")   buttonLabel = "Try again";
  else                          buttonLabel = "Upgrade";

  const busy = state === "upgrading" || state === "polling";
  const successTone = state === "done" || state === "copied";

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px 8px 16px",
        background: "var(--susu-surface-1)",
        border: "1px solid var(--susu-accent)",
        borderRadius: 999,
        boxShadow: "0 6px 20px rgba(0, 0, 0, 0.45)",
        fontSize: 12,
        fontFamily: "var(--susu-mono)",
        color: "var(--susu-ink)",
        maxWidth: "calc(100vw - 24px)",
      }}
    >
      <span
        aria-hidden
        className="susu-tick-pulse"
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--susu-accent)",
        }}
      />
      <span style={{ color: "var(--susu-ink-subtle)" }}>
        Daemon{" "}
        <strong style={{ color: "var(--susu-ink)" }}>
          v{currentVersion ?? "?"}
        </strong>{" "}
        → <strong style={{ color: "var(--susu-ink)" }}>v{latestVersion}</strong>
      </span>

      <button
        onClick={() => { if (!busy && state !== "done") void triggerUpgrade(); }}
        disabled={busy || state === "done"}
        style={{
          border: "none",
          padding: "4px 12px",
          borderRadius: 999,
          fontFamily: "inherit",
          fontSize: "inherit",
          letterSpacing: "0.04em",
          cursor: busy || state === "done" ? "default" : "pointer",
          background: successTone ? "#34d399" : "var(--susu-accent)",
          color: successTone ? "#0a1a14" : "var(--susu-bg)",
          opacity: busy ? 0.7 : 1,
          transition: "background-color 160ms ease, color 160ms ease, opacity 160ms ease",
        }}
        title="Click to upgrade. If your daemon is on this machine and reachable, it will self-upgrade; otherwise the installer command is copied to your clipboard."
      >
        {buttonLabel}
      </button>

      {error && (
        <span
          title={error}
          style={{
            color: "var(--susu-neg, #f78f8f)",
            maxWidth: 320,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      )}

      <button
        onClick={onDismiss}
        aria-label="Dismiss upgrade banner"
        title="Dismiss until next refresh"
        style={{
          border: "none",
          background: "transparent",
          color: "var(--susu-ink-subtle)",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: "2px 6px",
        }}
      >
        ×
      </button>
    </div>
  );
}

// ── Mode badge — tiny PAPER / LIVE pill rendered next to a position row ──

export function ModeBadge({ mode }: { mode: "paper" | "live" }) {
  const isLive = mode === "live";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 9,
        fontFamily: "var(--susu-mono)",
        letterSpacing: "0.08em",
        color: isLive ? "#1f1410" : "#0a1a14",
        background: isLive ? "#f6c177" : "#34d399",
        textTransform: "uppercase",
        verticalAlign: "middle",
      }}
      title={isLive ? "Live (real broker trade reported by the agent)" : "Paper (susurration simulator)"}
    >
      {mode}
    </span>
  );
}

// ── Equity curve — SVG sparkline with breathing endpoint halo ────────────

// Phase 18.2-w — EquityCurve accepts an optional `secondaryPoints` series so
// Overview can overlay paper and live books on the same axes (paper = green,
// live = amber, matching ModeBadge). The primary line dominates legibly;
// the secondary uses a thinner stroke + no fill + no breathing halo, so a
// flat / empty live curve doesn't clutter the chart when the user has only
// run paper.

const PRIMARY_COLOR = "#34d399";   // paper / single-mode default
const SECONDARY_COLOR = "#f6c177"; // live overlay

export function EquityCurve({
  points,
  secondaryPoints,
  initialBalance,
  height = 180,
  primaryColor = PRIMARY_COLOR,
  primaryLabel,
  secondaryLabel = "live",
}: {
  points: { day: string; realized_cumulative_usd: number }[];
  /** Optional second series, rendered as a lighter overlay. */
  secondaryPoints?: { day: string; realized_cumulative_usd: number }[];
  initialBalance: number;
  height?: number;
  /** Hex for primary line; defaults to paper green. Live-only views may pass amber. */
  primaryColor?: string;
  /** Optional inline legend chip for primary. Omit to suppress legend. */
  primaryLabel?: string;
  /** Inline legend chip for secondary. */
  secondaryLabel?: string;
}) {
  if (points.length === 0 && (!secondaryPoints || secondaryPoints.length === 0)) {
    return (
      <div className="susu-panel" style={{ padding: "var(--susu-s-5)", color: "var(--susu-ink-subtle)" }}>
        No history yet — your agent's first closed position will populate this curve.
      </div>
    );
  }

  const W = 720;
  const H = height;
  const padTop = 24;
  const padBot = 24;
  const yRange = H - padTop - padBot;

  // Map both series to balance arrays. If one is empty, we still need a
  // y-range that includes the other + the initial balance baseline.
  const primaryBalances = points.map(p => initialBalance + p.realized_cumulative_usd);
  const secondaryBalances = (secondaryPoints ?? []).map(p => initialBalance + p.realized_cumulative_usd);
  const allBalances = [...primaryBalances, ...secondaryBalances, initialBalance];
  const minB = Math.min(...allBalances);
  const maxB = Math.max(...allBalances);
  const span = Math.max(1, maxB - minB);

  // Each series gets its own x scale based on its own length. They should
  // both be `days` long in practice (server returns one row per calendar
  // day), so the x axes will coincide.
  const buildPts = (balances: number[]) => {
    if (balances.length === 0) return [] as { x: number; y: number }[];
    const stepX = balances.length > 1 ? W / (balances.length - 1) : W;
    return balances.map((b, i) => ({
      x: i * stepX,
      y: padTop + yRange * (1 - (b - minB) / span),
    }));
  };
  const ptsPrimary = buildPts(primaryBalances);
  const ptsSecondary = buildPts(secondaryBalances);

  const pathOf = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const primaryPath = pathOf(ptsPrimary);
  const secondaryPath = pathOf(ptsSecondary);

  const primaryFill = ptsPrimary.length > 0
    ? `${primaryPath} L${ptsPrimary[ptsPrimary.length - 1]!.x.toFixed(1)},${H} L0,${H} Z`
    : "";

  const primaryTail = ptsPrimary.length > 0 ? ptsPrimary[ptsPrimary.length - 1]! : null;
  const secondaryTail = ptsSecondary.length > 0 ? ptsSecondary[ptsSecondary.length - 1]! : null;

  const lastBalance = primaryBalances.length > 0
    ? primaryBalances[primaryBalances.length - 1]!
    : initialBalance;
  const ddPercent = ((minB - initialBalance) / initialBalance) * 100;

  // Use a stable gradient id keyed on color so multiple curves on one page
  // don't share defs (rare in practice but defensive).
  const gradId = `susu-eq-grad-${primaryColor.replace("#", "")}`;
  const showLegend = !!primaryLabel && ptsSecondary.length > 0;
  const labelDays = points.length || (secondaryPoints?.length ?? 0);

  return (
    <div className="susu-panel">
      <div style={{ padding: "var(--susu-s-5)" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--susu-s-3)",
          marginBottom: "var(--susu-s-3)",
          fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)",
        }}>
          <span>
            ${initialBalance.toLocaleString()} → ${lastBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            {" · "}{labelDays} days
            {ddPercent < 0 ? ` · max DD ${ddPercent.toFixed(2)}%` : ""}
          </span>
          {showLegend && (
            <span style={{ display: "flex", gap: "var(--susu-s-3)" }}>
              <LegendChip color={primaryColor} label={primaryLabel!} />
              <LegendChip color={SECONDARY_COLOR} label={secondaryLabel} />
            </span>
          )}
        </div>
        <svg viewBox={`0 0 ${W + 20} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={primaryColor} stopOpacity="0.24" />
              <stop offset="100%" stopColor={primaryColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1={padTop} x2={W + 20} y2={padTop} stroke="rgba(255,255,255,0.04)" />
          <line x1="0" y1={H / 2} x2={W + 20} y2={H / 2} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 3" />
          <line x1="0" y1={H - padBot} x2={W + 20} y2={H - padBot} stroke="rgba(255,255,255,0.04)" />
          {primaryFill && <path d={primaryFill} fill={`url(#${gradId})`} />}
          {/* Secondary first so primary draws on top — clearer hierarchy. */}
          {secondaryPath && (
            <path
              d={secondaryPath}
              fill="none"
              stroke={SECONDARY_COLOR}
              strokeWidth="1.25"
              strokeOpacity="0.85"
              strokeDasharray="3 2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {primaryPath && (
            <path d={primaryPath} fill="none" stroke={primaryColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {primaryTail && (
            <>
              <circle cx={primaryTail.x} cy={primaryTail.y} r="6" fill={primaryColor} opacity="0.32">
                <animate attributeName="r"       values="6;14;6"      dur="2.4s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.32;0;0.32" dur="2.4s" repeatCount="indefinite" />
              </circle>
              <circle cx={primaryTail.x} cy={primaryTail.y} r="3" fill={primaryColor} />
            </>
          )}
          {secondaryTail && (
            <circle cx={secondaryTail.x} cy={secondaryTail.y} r="2.5" fill={SECONDARY_COLOR} />
          )}
        </svg>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontFamily: "var(--susu-mono)", fontSize: 10, color: "var(--susu-ink-subtle)",
          marginTop: "var(--susu-s-3)",
        }}>
          {points.length > 0 && (
            <>
              <span>{formatDay(points[0]!.day)}</span>
              {points.length > 6 && <span>{formatDay(points[Math.floor(points.length * 0.25)]!.day)}</span>}
              {points.length > 4 && <span>{formatDay(points[Math.floor(points.length * 0.5)]!.day)}</span>}
              {points.length > 6 && <span>{formatDay(points[Math.floor(points.length * 0.75)]!.day)}</span>}
              <span>Today</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--susu-ink-subtle)" }}>
      <span style={{
        display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color,
      }} />
      {label}
    </span>
  );
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Time formatters used in feed rows ────────────────────────────────────

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const diff = nowMs - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// ── Tiny presentational helpers ──────────────────────────────────────────

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="susu-eyebrow">{children}</div>;
}

export function SectionTitle({ children, aux }: { children: ReactNode; aux?: ReactNode }) {
  return (
    <div className="susu-section-head">
      <div className="susu-section-title">{children}</div>
      {aux != null && <div className="susu-section-aux">{aux}</div>}
    </div>
  );
}

export function ReadOnlyFootnote() {
  return (
    <p style={{
      marginTop: "var(--susu-s-5)",
      fontFamily: "var(--susu-mono)",
      fontSize: 11,
      color: "var(--susu-ink-faint)",
      lineHeight: 1.6,
    }}>
      All actions push / react / open / close happen via your daemon and broker — this is a read-only view.
    </p>
  );
}
