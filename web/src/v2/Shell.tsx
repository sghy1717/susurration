// App shell — sidebar rail + top bar.
// Used by every v2 page so the chrome stays identical.

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ModePill, StatusDot, UpgradeBanner, Wordmark } from "./components";
import { useDaemonState, useDaemonUpgrade, useWhoAmI, durationStr } from "./hooks";
import { useLang } from "../i18n";

interface ShellProps {
  pageLabel: string;            // i18n key for the topbar crumb (e.g. "v2.page.overview")
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
  const { t, lang, setLang } = useLang();
  const location = useLocation();

  // Mobile drawer state — closes on route change so navigating from the
  // hamburger doesn't leave the rail open over the new page.
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => { setRailOpen(false); }, [location.pathname]);

  // Phase 18.2-w — render the upgrade banner across every v2 page.
  const upgrade = useDaemonUpgrade();
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem("susu.v2.upgrade-banner-dismissed") === "1"; }
    catch { return false; }
  });
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { sessionStorage.setItem("susu.v2.upgrade-banner-dismissed", "1"); } catch {}
  };

  const upgradeInFlight = upgrade.state === "upgrading" || upgrade.state === "polling";

  const statusKey = upgradeInFlight ? "v2.shell.upgrading"
    : daemon?.status === "online" ? "v2.shell.status.online"
    : daemon?.status === "stale" ? "v2.shell.status.stale"
    : daemon?.status === "never_seen" ? "v2.shell.status.neverSeen"
    : "v2.shell.status.dash";

  const uptimeText = (() => {
    if (upgradeInFlight) return upgrade.state === "upgrading" ? t("v2.shell.uptime.upgrading") : t("v2.shell.uptime.restarting");
    if (!daemon) return "—";
    if (daemon.status === "never_seen") return t("v2.shell.status.neverSeen");
    if (daemon.status === "stale") return t("v2.shell.status.stale");
    if (daemon.started_at) return durationStr(daemon.started_at, now);
    if (daemon.last_ping_at) return durationStr(daemon.last_ping_at, now);
    return t("v2.shell.status.online");
  })();

  return (
    <div className={`susu-shell${railOpen ? " rail-open" : ""}`}>
      {!bannerDismissed && (
        <UpgradeBanner status={upgrade} onDismiss={dismissBanner} />
      )}
      <div className="susu-rail-backdrop" onClick={() => setRailOpen(false)} />
      <aside className="susu-rail">
        <div className="susu-brand">
          <Wordmark size="lg" />
        </div>

        <div className="susu-nav-section">{t("v2.nav.workspace")}</div>
        <NavItem to="/v2/overview" label={t("v2.nav.overview")} icon={IconGrid} />
        <NavItem to="/v2/feed" label={t("v2.nav.feed")} icon={IconFeed} />
        <NavItem to="/v2/friends" label={t("v2.nav.friends")} icon={IconPeople} />
        <NavItem to="/v2/book" label={t("v2.nav.book")} icon={IconBook} />

        <div className="susu-nav-section" style={{ marginTop: "var(--susu-s-4)" }}>{t("v2.nav.agent")}</div>
        <NavItem to="/v2/daemon" label={t("v2.nav.daemon")} icon={IconClock} />
        <NavItem to="/v2/risk" label={t("v2.nav.risk")} icon={IconShield} />
        <NavItem to="/v2/settings" label={t("v2.nav.settings")} icon={IconCog} />

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
                {me?.username ? `@${me.username}` : t("v2.shell.anon")}
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
          <button
            className="susu-rail-toggle"
            onClick={() => setRailOpen(v => !v)}
            aria-label={railOpen ? t("v2.shell.menu.close") : t("v2.shell.menu.open")}
          >
            <IconBurger />
          </button>
          <div className="susu-topbar-crumb">
            <strong>{t(pageLabel)}</strong>
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
            <span>{t("v2.shell.daemonStatus", { status: t(statusKey), uptime: uptimeText })}</span>
            {daemon?.version && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span>v{daemon.version}</span>
              </>
            )}
            <span style={{ opacity: 0.4 }}>·</span>
            <ModePill mode={daemon?.execution_mode ?? null} />
          </div>
          <button
            className="susu-lang-toggle"
            onClick={() => setLang(lang === "en" ? "zh" : "en")}
            title={t("v2.shell.lang.tooltip")}
          >
            {lang === "en" ? "中文" : "EN"}
          </button>
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
// Proper gear: 8 teeth + center hole, recognizably ⚙ at 16px.
const IconCog = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 0.8v2.4M8 12.8v2.4M0.8 8h2.4M12.8 8h2.4M2.9 2.9l1.7 1.7M11.4 11.4l1.7 1.7M2.9 13.1l1.7-1.7M11.4 4.6l1.7-1.7" />
  </svg>
);
const IconBurger = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ width: 18, height: 18 }}>
    <path d="M2 4h12M2 8h12M2 12h12" />
  </svg>
);

// expose useNow for pages that need their own counters
export { useNow };
