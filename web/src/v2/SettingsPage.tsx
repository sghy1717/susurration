// Settings page — identity + token + webhook + sign out. Minimal v2 port;
// the v0 SettingsPage has more sections (language toggle, etc) we'll
// migrate as v2 grows. For now this covers the four things every user
// actually needs from a settings surface.

import { useEffect, useState } from "react";
import { Shell } from "./Shell";
import { useWhoAmI } from "./hooks";
import { Eyebrow, SectionTitle, ReadOnlyFootnote } from "./components";
import { api, session } from "../api";

export function SettingsPage() {
  return (
    <Shell pageLabel="settings">
      <SettingsBody />
    </Shell>
  );
}

function SettingsBody() {
  const { data: me } = useWhoAmI();
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ url: string | null }>({ path: "/identity/webhook" })
      .then(r => { if (!cancelled) { setWebhookUrl(r.url); setWebhookLoading(false); }})
      .catch(() => { if (!cancelled) { setWebhookUrl(null); setWebhookLoading(false); }});
    return () => { cancelled = true; };
  }, []);

  const token = session.token ?? "";
  const tokenMasked = token ? `${token.slice(0, 8)}…${token.slice(-4)}` : "—";
  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2500);
    } catch { /* clipboard blocked; user can select the revealed string */ }
  };

  const handleSignOut = () => {
    if (!confirm("Sign out of this dashboard? Your daemon stays running; only the browser session is cleared.")) return;
    session.clear();
    window.location.href = "/";
  };

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>account · settings</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>Settings</h1>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--susu-s-6)",
      }}>
        <section className="susu-section">
          <SectionTitle>Identity</SectionTitle>
          <div className="susu-panel" style={{ padding: 0 }}>
            <Row label="Handle" value={me?.username ? `@${me.username}` : "—"} />
            <Row label="Address" value={
              me?.address
                ? <code style={{ fontSize: 11, color: "var(--susu-ink)" }}>{me.address}</code>
                : "—"
            } />
            <Row label="Daemon version" value={me?.last_daemon_version ? `v${me.last_daemon_version}` : "—"} />
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>API token</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-4)" }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--susu-s-3)",
              fontFamily: "var(--susu-mono)", fontSize: 12,
            }}>
              <code style={{
                color: "var(--susu-ink)",
                background: "var(--susu-surface-0)",
                padding: "4px 8px", borderRadius: 4,
                fontSize: 11, wordBreak: "break-all",
              }}>
                {tokenRevealed ? token : tokenMasked}
              </code>
              <span style={{ display: "flex", gap: "var(--susu-s-2)", flexShrink: 0 }}>
                <button
                  className="susu-btn susu-btn-ghost susu-btn-sm"
                  onClick={() => setTokenRevealed(v => !v)}
                  title={tokenRevealed ? "Hide" : "Reveal"}
                >
                  {tokenRevealed ? "Hide" : "Reveal"}
                </button>
                <button
                  className="susu-btn susu-btn-sm"
                  onClick={copyToken}
                  disabled={!token}
                  title="Copy full token to clipboard"
                >
                  {tokenCopied ? "✓ Copied" : "Copy"}
                </button>
              </span>
            </div>
            <p style={{
              marginTop: "var(--susu-s-3)",
              fontSize: 11, color: "var(--susu-ink-subtle)", lineHeight: 1.5,
            }}>
              Pass this to <code>npx -y @susurration/installer install --token &lt;token&gt;</code> on a
              new machine to wire up its daemon. Anyone with the token can act
              as you — don't paste it into chat or logs.
            </p>
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>Webhook</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-4)" }}>
            {webhookLoading ? (
              <span style={{ color: "var(--susu-ink-subtle)" }}>loading…</span>
            ) : webhookUrl ? (
              <>
                <code style={{
                  display: "block",
                  fontSize: 11, color: "var(--susu-ink)",
                  wordBreak: "break-all",
                  marginBottom: "var(--susu-s-3)",
                }}>
                  {webhookUrl}
                </code>
                <p style={{ fontSize: 11, color: "var(--susu-ink-subtle)", lineHeight: 1.5 }}>
                  Server POSTs every incoming signal + reaction to this URL.
                  Manage with the CLI: <code>susu webhook set &lt;url&gt;</code> / <code>susu webhook clear</code>.
                </p>
              </>
            ) : (
              <p style={{ fontSize: 12, color: "var(--susu-ink-subtle)", lineHeight: 1.5 }}>
                No webhook configured. Optional integration point if you want
                signals POSTed somewhere besides your daemon — Slack relay,
                custom logger, etc. Set with <code>susu webhook set &lt;url&gt;</code>.
              </p>
            )}
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>Session</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-4)" }}>
            <p style={{ fontSize: 12, color: "var(--susu-ink-subtle)", lineHeight: 1.5, marginBottom: "var(--susu-s-3)" }}>
              Clears your token from this browser only. The daemon on your
              machine keeps running with the same token; sign back in on
              another device by pasting the token from above.
            </p>
            <button className="susu-btn susu-btn-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </section>
      </div>

      <ReadOnlyFootnote />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "var(--susu-s-3) var(--susu-s-4)",
      borderBottom: "1px solid var(--susu-hairline)",
      fontFamily: "var(--susu-mono)", fontSize: 12,
    }}>
      <span style={{ color: "var(--susu-ink-subtle)" }}>{label}</span>
      <span style={{ color: "var(--susu-ink)", textAlign: "right" }}>{value}</span>
    </div>
  );
}
