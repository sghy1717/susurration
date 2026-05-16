// Susurration web app — route dispatcher.
//
// Routes:
//   /     → LandingPage (cream/ink brand, 3 copy boxes = onboarding surface)
//   /docs → DocsPage    (cream/ink, sidebar nav)
//
// D14: web onboarding flow removed entirely.
// Reason: Phantom keypair lives in the browser extension; CLI keypair lives
// in ~/.susu/config.json. They are different keys. A web "register username"
// step would force the CLI user to register again with a different identity
// — net negative UX. The 3 landing CopyBoxes (CLI / MCP / AGENT DOC) are
// the complete onboarding surface; users go straight from copy → terminal.
//
// Tagline framing: NARROW (trading-focused) per BETA scope. To pivot to
// BROAD (general agent collaboration), edit TAGLINE in LandingPage.tsx.

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

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />

          {/* Phase 18.2-w — v2 dashboard is the default. /dashboard redirects
              into v2 so existing bookmarks + landing-page CTA work without
              edit. /v0/dashboard kept as escape hatch for users who hit
              regressions during the rollout — drop it once v2 is stable. */}
          <Route path="/dashboard" element={<Navigate to="/v2/overview" replace />} />
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
