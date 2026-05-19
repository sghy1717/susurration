// Settings page — identity + token + webhook + sign out. Minimal v2 port;
// the v0 SettingsPage has more sections (language toggle, etc) we'll
// migrate as v2 grows. For now this covers the four things every user
// actually needs from a settings surface.

import { useEffect, useState } from "react";
import { Shell } from "./Shell";
import { useWhoAmI } from "./hooks";
import { Eyebrow, SectionTitle, ReadOnlyFootnote } from "./components";
import { api, session } from "../api";
import { useLang } from "../i18n";

export function SettingsPage() {
  return (
    <Shell pageLabel="v2.page.settings">
      <SettingsBody />
    </Shell>
  );
}

function SettingsBody() {
  const { t } = useLang();
  const { data: me } = useWhoAmI();
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ webhook_url: string | null }>({ path: "/identity/webhook" })
      .then(r => { if (!cancelled) { setWebhookUrl(r.webhook_url); setWebhookLoading(false); }})
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
    if (!confirm(t("v2.settings.session.confirm"))) return;
    session.clear();
    window.location.href = "/";
  };

  return (
    <>
      <div style={{ marginBottom: "var(--susu-s-6)" }}>
        <Eyebrow>{t("v2.settings.eyebrow")}</Eyebrow>
        <h1 className="susu-h1" style={{ marginTop: "var(--susu-s-2)" }}>{t("v2.settings.title")}</h1>
      </div>

      <div className="susu-grid-11">
        <section className="susu-section">
          <SectionTitle>{t("v2.settings.sec.identity")}</SectionTitle>
          <div className="susu-panel" style={{ padding: 0 }}>
            <Row label={t("v2.settings.row.handle")} value={me?.username ? `@${me.username}` : "—"} />
            <Row label={t("v2.settings.row.address")} value={
              me?.address
                ? <code style={{ fontSize: 11, color: "var(--susu-ink)" }}>{me.address}</code>
                : "—"
            } />
            <Row label={t("v2.settings.row.version")} value={me?.last_daemon_version ? `v${me.last_daemon_version}` : "—"} />
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>{t("v2.settings.sec.token")}</SectionTitle>
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
                  title={tokenRevealed ? t("v2.settings.token.hide") : t("v2.settings.token.reveal")}
                >
                  {tokenRevealed ? t("v2.settings.token.hide") : t("v2.settings.token.reveal")}
                </button>
                <button
                  className="susu-btn susu-btn-sm"
                  onClick={copyToken}
                  disabled={!token}
                  title={t("v2.settings.token.copyTitle")}
                >
                  {tokenCopied ? t("v2.settings.token.copied") : t("v2.settings.token.copy")}
                </button>
              </span>
            </div>
            <p style={{
              marginTop: "var(--susu-s-3)",
              fontSize: 11, color: "var(--susu-ink-subtle)", lineHeight: 1.5,
            }}>
              {t("v2.settings.token.help.pre")}<code>npx -y @susurration/installer@latest install --token &lt;token&gt;</code>{t("v2.settings.token.help.post")}
            </p>
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>{t("v2.settings.sec.webhook")}</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-4)" }}>
            {webhookLoading ? (
              <span style={{ color: "var(--susu-ink-subtle)" }}>{t("v2.settings.webhook.loading")}</span>
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
                  {t("v2.settings.webhook.help.pre")}<code>susu webhook set &lt;url&gt;</code>{t("v2.settings.webhook.help.or")}<code>susu webhook clear</code>{t("v2.settings.webhook.help.suffix")}
                </p>
              </>
            ) : (
              <p style={{ fontSize: 12, color: "var(--susu-ink-subtle)", lineHeight: 1.5 }}>
                {t("v2.settings.webhook.none")}<code>susu webhook set &lt;url&gt;</code>{t("v2.settings.webhook.none.suffix")}
              </p>
            )}
          </div>
        </section>

        <section className="susu-section">
          <SectionTitle>{t("v2.settings.sec.session")}</SectionTitle>
          <div className="susu-panel" style={{ padding: "var(--susu-s-4)" }}>
            <p style={{ fontSize: 12, color: "var(--susu-ink-subtle)", lineHeight: 1.5, marginBottom: "var(--susu-s-3)" }}>
              {t("v2.settings.session.help")}
            </p>
            <button className="susu-btn susu-btn-ghost" onClick={handleSignOut}>
              {t("v2.settings.session.signOut")}
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
