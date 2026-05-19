// Susurration web app — route dispatcher.
//
// Routes:
//   /     → LandingPage (agent-network marketing surface)
//   /docs → DocsPage    (reference entry)
//
// D14: web onboarding flow removed entirely.
// Reason: Phantom keypair lives in the browser extension; CLI keypair lives
// in ~/.susu/config.json. They are different keys. A web "register username"
// step would force the CLI user to register again with a different identity
// — net negative UX. The 3 landing CopyBoxes (CLI / MCP / AGENT DOC) are
// the complete onboarding surface; users go straight from copy → terminal.
//
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LanguageProvider } from "./i18n.tsx";
import { LandingPage } from "./LandingPage.tsx";
import { DocsPage } from "./DocsPage.tsx";
import { DashboardPage } from "./DashboardPage.tsx";
import { OverviewPage } from "./v2/OverviewPage.tsx";
import { FeedPage } from "./v2/FeedPage.tsx";
import { FriendsPage } from "./v2/FriendsPage.tsx";
import { BookPage } from "./v2/BookPage.tsx";
import { DaemonPage } from "./v2/DaemonPage.tsx";
import { RiskPage } from "./v2/RiskPage.tsx";
import { SettingsPage } from "./v2/SettingsPage.tsx";
import "./v2/tokens.css";

function DashboardEntry() {
  const hasToken = typeof window !== "undefined"
    && (localStorage.getItem("susu.token") || localStorage.getItem("susu_token"));

  return hasToken
    ? <Navigate to="/v2/overview" replace />
    : <Navigate to="/v0/dashboard?return=v2" replace />;
}

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />

          {/* /dashboard is the public entry point. Logged-in users go straight
              to v2; first-time users go directly to the wallet/onboarding flow
              with return=v2, avoiding the old landing → v2 anon splash → v0
              loop. /v0/dashboard remains as the onboarding implementation. */}
          <Route path="/dashboard" element={<DashboardEntry />} />
          <Route path="/v0/dashboard" element={<DashboardPage />} />

          <Route path="/v2" element={<Navigate to="/v2/overview" replace />} />
          <Route path="/v2/overview" element={<OverviewPage />} />
          <Route path="/v2/feed" element={<FeedPage />} />
          <Route path="/v2/friends" element={<FriendsPage />} />
          <Route path="/v2/book" element={<BookPage />} />
          <Route path="/v2/daemon" element={<DaemonPage />} />
          <Route path="/v2/risk" element={<RiskPage />} />
          <Route path="/v2/settings" element={<SettingsPage />} />

          <Route path="*" element={<LandingPage />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
