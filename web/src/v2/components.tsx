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

  const { state, error, copied, oneClickReady, currentVersion, latestVersion,
    triggerOneClick, triggerCopyCommand } = status;

  // After a one-click failure, fall through to copy-command for retries.
  const effectiveOneClick = oneClickReady && state !== "error";
  const handleClick = effectiveOneClick ? triggerOneClick : triggerCopyCommand;

  let buttonLabel: string;
  if (state === "upgrading")       buttonLabel = "Upgrading…";
  else if (state === "polling")    buttonLabel = "Restarting daemon…";
  else if (state === "done")       buttonLabel = "✓ Upgraded";
  else if (state === "error")      buttonLabel = copied ? "✓ Copied" : "Copy upgrade cmd";
  else if (effectiveOneClick)      buttonLabel = "Upgrade now";
  else                             buttonLabel = copied ? "✓ Copied" : "Copy upgrade cmd";

  const busy = state === "upgrading" || state === "polling";
  const successTone = copied || state === "done";

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
        onClick={() => { if (!busy && state !== "done") handleClick(); }}
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
        title={effectiveOneClick
          ? "Trigger your local daemon's /upgrade endpoint and wait for it to come back online."
          : "Copy the installer command — paste in your terminal to upgrade manually."
        }
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

export function EquityCurve({
  points,
  initialBalance,
  height = 180,
}: {
  points: { day: string; realized_cumulative_usd: number }[];
  initialBalance: number;
  height?: number;
}) {
  if (points.length === 0) {
    return (
      <div className="susu-panel" style={{ padding: "var(--susu-s-5)", color: "var(--susu-ink-subtle)" }}>
        No history yet — your agent's first closed position will populate this curve.
      </div>
    );
  }

  // Convert to balance series (initial + cumulative realized).
  const balances = points.map(p => initialBalance + p.realized_cumulative_usd);
  const minB = Math.min(...balances, initialBalance);
  const maxB = Math.max(...balances, initialBalance);
  const span = Math.max(1, maxB - minB);
  const W = 720;
  const H = height;
  const padTop = 24;
  const padBot = 24;
  const yRange = H - padTop - padBot;
  const stepX = points.length > 1 ? W / (points.length - 1) : W;

  const pts = balances.map((b, i) => {
    const x = i * stepX;
    const y = padTop + yRange * (1 - (b - minB) / span);
    return { x, y };
  });
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const fillPath = `${linePath} L${pts[pts.length - 1]!.x.toFixed(1)},${H} L0,${H} Z`;
  const tail = pts[pts.length - 1]!;
  const ddPercent = ((minB - initialBalance) / initialBalance) * 100;
  const lastBalance = balances[balances.length - 1]!;

  return (
    <div className="susu-panel">
      <div style={{ padding: "var(--susu-s-5)" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          marginBottom: "var(--susu-s-3)",
          fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)",
        }}>
          <span>
            ${initialBalance.toLocaleString()} → ${lastBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            {" · "}{points.length} days
            {ddPercent < 0 ? ` · max DD ${ddPercent.toFixed(2)}%` : ""}
          </span>
        </div>
        <svg viewBox={`0 0 ${W + 20} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
          <defs>
            <linearGradient id="susu-eq-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1={padTop} x2={W + 20} y2={padTop} stroke="rgba(255,255,255,0.04)" />
          <line x1="0" y1={H / 2} x2={W + 20} y2={H / 2} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 3" />
          <line x1="0" y1={H - padBot} x2={W + 20} y2={H - padBot} stroke="rgba(255,255,255,0.04)" />
          <path d={fillPath} fill="url(#susu-eq-grad)" />
          <path d={linePath} fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={tail.x} cy={tail.y} r="6" fill="#34d399" opacity="0.32">
            <animate attributeName="r"       values="6;14;6"      dur="2.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.32;0;0.32" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle cx={tail.x} cy={tail.y} r="3" fill="#34d399" />
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
