// App shell — sidebar rail + top bar.
// Used by every v2 page so the chrome stays identical.

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ModePill, StatusDot, UpgradeBanner, Wordmark } from "./components";
import { useDaemonState, useDaemonUpgrade, useWhoAmI, durationStr } from "./hooks";

interface ShellProps {
  pageLabel: string;            // shown in topbar after `susurration/`
  topbarAux?: ReactNode;        // page-specific status text (e.g. "streaming · 12 events / hr")
  topbarActions?: ReactNode;    // page-specific buttons (e.g. "Export book")
  children: ReactNode;
}

// One-second tick to refresh uptime / duration counters.
function useNow(intervalMs: number = 1000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

export function Shell({ pageLabel, topbarAux, topbarActions, children }: ShellProps) {
  const { data: daemon } = useDaemonState();
  const { data: me } = useWhoAmI();
  const now = useNow();

  // Phase 18.2-w — render the upgrade banner across every v2 page. Banner
  // self-hides when there is no pending upgrade. Dismiss persists in
  // sessionStorage (this tab only) so navigating between v2 pages doesn't
  // re-show the banner every time — but next browser-session reopens it,
  // intentional since old daemons miss bug fixes.
  const upgrade = useDaemonUpgrade();
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem("susu.v2.upgrade-banner-dismissed") === "1"; }
    catch { return false; }
  });
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { sessionStorage.setItem("susu.v2.upgrade-banner-dismissed", "1"); } catch {}
  };

  // Phase 18.2-w — during an in-flight upgrade, the SSE stream is briefly
  // down so the server's "last ping" clock will roll past STALE_AFTER_SECONDS
  // (90s) for any upgrade that crosses that threshold. The topbar would then
  // show "daemon stale" alongside the banner's "Upgrading…" — confusing and
  // inaccurate. Override the displayed status while we're mid-handoff so
  // the user sees a single coherent story.
  const upgradeInFlight = upgrade.state === "upgrading" || upgrade.state === "polling";

  const uptimeText = (() => {
    if (upgradeInFlight) return upgrade.state === "upgrading" ? "upgrading…" : "restarting…";
    if (!daemon) return "—";
    if (daemon.status === "never_seen") return "never seen";
    if (daemon.status === "stale") return "stale";
    if (daemon.started_at) return durationStr(daemon.started_at, now);
    if (daemon.last_ping_at) return durationStr(daemon.last_ping_at, now);
    return "online";
  })();

  return (
    <div className="susu-shell">
      {!bannerDismissed && (
        <UpgradeBanner status={upgrade} onDismiss={dismissBanner} />
      )}
      <aside className="susu-rail">
        <div className="susu-brand">
          <Wordmark size="lg" />
        </div>

        <div className="susu-nav-section">Workspace</div>
        <NavItem to="/v2/overview" label="Overview" icon={IconGrid} />
        <NavItem to="/v2/feed" label="Signal feed" icon={IconFeed} />
        <NavItem to="/v2/friends" label="Friends & channels" icon={IconPeople} />
        <NavItem to="/v2/book" label="Book" icon={IconBook} />

        <div className="susu-nav-section" style={{ marginTop: "var(--susu-s-4)" }}>Agent</div>
        <NavItem to="/v2/daemon" label="Daemon" icon={IconClock} />
        <NavItem to="/v2/risk" label="Risk caps" icon={IconShield} />
        <NavItem to="/v2/settings" label="Settings" icon={IconCog} />

        <div style={{ marginTop: "auto", padding: "var(--susu-s-4) var(--susu-s-3)", borderTop: "1px solid var(--susu-hairline)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-3)" }}>
            <div
              className="susu-avatar round"
              style={{
                background: "linear-gradient(135deg,#4eb1ff,#7ec5ff)",
                color: "#06121a",
                fontWeight: 600,
              }}
            >
              {(me?.username?.[0] ?? me?.address?.[0] ?? "?").toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: "var(--susu-text-sm)",
                color: "var(--susu-ink)",
                fontFamily: "var(--susu-mono)",
              }}>
                {me?.username ? `@${me.username}` : "anon"}
              </div>
              <div style={{
                fontSize: 11,
                color: "var(--susu-ink-subtle)",
                fontFamily: "var(--susu-mono)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {me?.address ? `${me.address.slice(0, 4)}…${me.address.slice(-4)}` : "—"}
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="susu-main">
        <header className="susu-topbar">
          <div className="susu-topbar-crumb">
            <Wordmark size="sm" /> &nbsp;<strong>{pageLabel}</strong>
          </div>
          <div style={{ flex: 1 }} />
          {topbarAux != null && (
            <div style={{
              display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
              fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)",
            }}>
              {topbarAux}
            </div>
          )}
          <div style={{
            display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
            fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)",
          }}>
            <StatusDot kind={
              upgradeInFlight ? "warn"
              : daemon?.status === "online" ? "live"
              : daemon?.status === "stale" ? "warn"
              : "idle"
            } />
            <span>daemon {upgradeInFlight ? "upgrading" : (daemon?.status ?? "—")} · {uptimeText}</span>
            {daemon?.version && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>v{daemon.version}</span>
              </>
            )}
            <span style={{ opacity: 0.4 }}>·</span>
            <ModePill mode={daemon?.execution_mode ?? null} />
          </div>
          {topbarActions}
        </header>

        <div className="susu-content">{children}</div>
      </main>
    </div>
  );
}

function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: () => ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => `susu-nav-item${isActive ? " active" : ""}`}>
      <span className="susu-nav-icon">{Icon()}</span>
      {label}
    </NavLink>
  );
}

// ── Inline SVG icons (no external dep) ───────────────────────────────────

function svg(d: string) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
      {d.split("|").map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const IconGrid = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
);
const IconFeed = () => svg("M2 8h2l1.5-4 3 8 2-5 1.5 3H14");
const IconPeople = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <circle cx="6" cy="6" r="2.5" />
    <path d="M2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4" />
    <circle cx="11.5" cy="5" r="1.8" />
    <path d="M9.5 12.5c.6-1.6 2-2.5 3.5-2.5 1.2 0 2 .6 2 1.8" />
  </svg>
);
const IconBook = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <path d="M3 13V6l5-3 5 3v7" />
    <rect x="6" y="9" width="4" height="4" />
  </svg>
);
const IconClock = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);
const IconShield = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <path d="M5 7l1.5 1.5L9 6" />
  </svg>
);
const IconCog = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 16, height: 16 }}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M2.5 6.5L1 7l1 2 1.5-.5M13 4.5l1-1.5L12 2l-.5 1.5" />
  </svg>
);

// expose useNow for pages that need their own counters
export { useNow };
