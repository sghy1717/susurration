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
import { Shell } from "./v2/Shell.tsx";
import "./v2/tokens.css";

function Placeholder({ label }: { label: string }) {
  return (
    <Shell pageLabel={label}>
      <div style={{ padding: "var(--susu-s-8)", textAlign: "center", color: "var(--susu-ink-subtle)" }}>
        <div className="susu-eyebrow" style={{ marginBottom: "var(--susu-s-3)" }}>{label}</div>
        <h2 className="susu-h2">Coming in v2.1</h2>
        <p className="susu-body" style={{ marginTop: "var(--susu-s-3)", maxWidth: "48ch", marginLeft: "auto", marginRight: "auto" }}>
          This surface is intentionally empty in the v2 first ship. Decide what
          belongs here by watching how peers' agents actually use the network.
        </p>
      </div>
    </Shell>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />

          {/* v2 redesigned dashboard */}
          <Route path="/v2" element={<Navigate to="/v2/overview" replace />} />
          <Route path="/v2/overview" element={<OverviewPage />} />
          <Route path="/v2/feed" element={<FeedPage />} />
          <Route path="/v2/friends" element={<FriendsPage />} />
          <Route path="/v2/book" element={<Placeholder label="book" />} />
          <Route path="/v2/daemon" element={<Placeholder label="daemon" />} />
          <Route path="/v2/risk" element={<Placeholder label="risk caps" />} />
          <Route path="/v2/settings" element={<Placeholder label="settings" />} />

          <Route path="*" element={<LandingPage />} />
        </Routes>
      </BrowserRouter>
    </LanguageProvider>
  );
}
