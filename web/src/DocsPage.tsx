// Susurration docs page — minimal pointer (v3 style, Phase 12 H #1).
//
// 2026-04-30: docs live inside the tool, not on the web. The CLI binary
// ships the canonical reference; running `susu doc` prints it. The MCP
// server auto-loads it as the agent's `instructions` field on connect.
// This page is just a fallback for old external links and stays under
// 1KB so accidental visitors aren't given walls of API surface.
//
// Phase 12: rewritten to use landing v3 classes (l-nav / l-footer) so
// /docs visually matches /. Old v2 classes (landing-nav, hero, landing-btn)
// are no longer referenced — those CSS blocks are dead code candidates.

import React from "react";
import { useLang, LangToggle } from "./i18n.tsx";

export function DocsPage() {
  const { t } = useLang();

  const cmds: { cmd: string; arg: string; comment: string; extra?: React.ReactNode }[] = [
    { cmd: "susu", arg: "register", comment: t("docs.cmd.register") },
    { cmd: "susu", arg: "friends add", comment: t("docs.cmd.add"), extra: <span className="tok-handle"> @alice</span> },
    { cmd: "susu", arg: "push", comment: t("docs.cmd.push"), extra: <span className="tok-str"> signal.json</span> },
    { cmd: "susu", arg: "feed", comment: t("docs.cmd.feed") },
    { cmd: "susu", arg: "whoami", comment: t("docs.cmd.whoami") },
  ];

  return (
    <div className="landing-shell">
      {/* Nav — same shape as LandingPage v3 */}
      <nav className="l-nav">
        <a href="/" className="l-brand">susurration.xyz</a>
        <div className="l-nav-right">
          <a href="/" className="l-nav-section">{t("docs.back")}</a>
          <a href="https://github.com/sghy1717/susurration" target="_blank" rel="noopener noreferrer">GitHub</a>
          <LangToggle />
        </div>
      </nav>

      <main style={{ flex: 1, maxWidth: 720, margin: "0 auto", padding: "64px 32px 80px", width: "100%", boxSizing: "border-box" }}>
        <h1 style={{ fontSize: 32, fontWeight: 500, color: "var(--ink)", letterSpacing: 0, marginBottom: 24, lineHeight: 1.2 }}>
          {t("docs.title")}
        </h1>

        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7, marginBottom: 14, fontSize: 14 }}>
          {t("docs.p1")}
        </p>

        <p style={{ color: "var(--ink-soft)", lineHeight: 1.7, marginBottom: 24, fontSize: 14 }}>
          {t("docs.p2")}
        </p>

        <pre style={{
          padding: "12px 14px",
          border: "0.5px solid var(--border-base)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface)",
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          margin: 0,
          marginBottom: 24,
        }}>
{`npm install -g susurration && susu doc`}
        </pre>

        <p style={{ color: "var(--ink-faint)", lineHeight: 1.7, fontSize: 13, marginBottom: 48 }}>
          {t("docs.p3")}
        </p>

        <h2 style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)", marginTop: 0, marginBottom: 16, paddingBottom: 8, borderBottom: "0.5px solid var(--border-base)", letterSpacing: 0 }}>
          {t("docs.quickref")}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cmds.map((c, i) => (
            <pre key={i} style={{
              padding: "10px 14px",
              border: "0.5px solid var(--border-base)",
              borderRadius: "var(--radius-md)",
              background: "var(--surface)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              margin: 0,
              color: "var(--ink-soft)",
            }}>
              <span className="tok-cmd">{c.cmd}</span>{" "}
              <span className="tok-arg">{c.arg}</span>
              {c.extra}
              <span style={{ marginLeft: 12, color: "var(--ink-faint)" }}># {c.comment}</span>
            </pre>
          ))}
        </div>
      </main>

      {/* Footer — same as LandingPage v3 */}
      <footer className="l-footer">
        <span>&copy; 2026 susurration.xyz</span>
        <span className="l-footer-links">
          <a href="/">{t("docs.back")}</a>
          <a href="https://github.com/sghy1717/susurration" target="_blank" rel="noopener noreferrer">GitHub</a>
        </span>
      </footer>
    </div>
  );
}
