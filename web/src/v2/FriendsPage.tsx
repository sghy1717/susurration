// Friends & channels page — list left, detail right.
// Only human-triggered writes are allowed here (add friend / accept request).
// All other state is read-only per the agent-native framing.

import { useEffect, useState } from "react";
import { Shell } from "./Shell";
import {
  useFriends, usePendingRequests, useChannelGroups, usePeerDetail,
  formatPnl, formatPercent,
  type Friend, type PendingRequest, type ChannelGroup,
} from "./hooks";
import { api } from "../api";
import {
  Eyebrow, Tag, Avatar, formatRelative,
} from "./components";
import { useLang } from "../i18n";

type LeftTab = "friends" | "channels" | "pending";

export function FriendsPage() {
  const { t } = useLang();
  const [tab, setTab] = useState<LeftTab>("friends");
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const { data: friendsResp, refetch: refetchFriends } = useFriends();
  const { data: pendingResp, refetch: refetchPending } = usePendingRequests();
  const { data: channelsResp } = useChannelGroups();

  const friends = friendsResp?.friends ?? [];
  const pending = pendingResp?.requests ?? [];
  const channels = channelsResp?.groups ?? [];

  // Default selection: first friend once the list arrives. useEffect (not an
  // inline setTimeout during render) so React 18 strict mode doesn't warn and
  // the scheduler can batch the update with the rest of the commit phase.
  useEffect(() => {
    if (selectedAddress == null && friends.length > 0) {
      setSelectedAddress(friends[0]!.friend_address);
    }
  }, [friends, selectedAddress]);

  return (
    <Shell
      pageLabel="v2.page.friends"
      topbarAux={
        <span>{t("v2.friends.topbar", { f: friends.length, c: channels.length })}{pending.length > 0 ? t("v2.friends.topbar.pending", { n: pending.length }) : ""}</span>
      }
    >
      <div style={{ marginBottom: "var(--susu-s-5)" }}>
        <Eyebrow>{t("v2.friends.eyebrow")}</Eyebrow>
        <h1 className="susu-h2" style={{ marginTop: "var(--susu-s-2)" }}>{t("v2.friends.h1")}</h1>
        <p className="susu-body" style={{ marginTop: "var(--susu-s-2)", maxWidth: "64ch" }}>
          {t("v2.friends.intro")}
        </p>
      </div>

      <div className="susu-grid-sidebar">
        <LeftRail
          tab={tab} setTab={setTab}
          friends={friends} pending={pending} channels={channels}
          counts={{ friends: friends.length, channels: channels.length, pending: pending.length }}
          selected={selectedAddress}
          onSelect={setSelectedAddress}
          onChange={() => { refetchFriends(); refetchPending(); }}
        />
        <DetailPanel address={selectedAddress} channels={channels} />
      </div>
    </Shell>
  );
}

function LeftRail({
  tab, setTab, friends, pending, channels, counts, selected, onSelect, onChange,
}: {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  friends: Friend[];
  pending: PendingRequest[];
  channels: ChannelGroup[];
  counts: { friends: number; channels: number; pending: number };
  selected: string | null;
  onSelect: (addr: string) => void;
  onChange: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="susu-panel">
      <div style={{
        display: "flex", borderBottom: "1px solid var(--susu-hairline)",
        padding: "0 var(--susu-s-3)",
      }}>
        <TabButton on={tab === "friends"} onClick={() => setTab("friends")}>{t("v2.friends.tab.friends")} <Count>{counts.friends}</Count></TabButton>
        <TabButton on={tab === "channels"} onClick={() => setTab("channels")}>{t("v2.friends.tab.channels")} <Count>{counts.channels}</Count></TabButton>
        <TabButton on={tab === "pending"} onClick={() => setTab("pending")}>{t("v2.friends.tab.pending")} <Count>{counts.pending}</Count></TabButton>
      </div>

      <div style={{ padding: "var(--susu-s-3)" }}>
        {tab === "friends" && (
          <>
            <AddFriendInput onAdded={onChange} />
            {friends.length === 0 ? (
              <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)", fontSize: 13 }}>
                {t("v2.friends.empty.friends")}
              </div>
            ) : friends.map(f => (
              <FriendRow
                key={f.friend_address}
                friend={f}
                selected={f.friend_address === selected}
                onClick={() => onSelect(f.friend_address)}
              />
            ))}
          </>
        )}

        {tab === "channels" && (
          channels.length === 0 ? (
            <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)", fontSize: 13 }}>
              {t("v2.friends.empty.channels")}
            </div>
          ) : channels.map(c => (
            <div key={c.channel_id} style={{
              display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
              padding: "var(--susu-s-3)",
            }}>
              <div className="susu-avatar">#</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="susu-mono" style={{ fontSize: 13 }}>{c.name ?? c.channel_id.slice(0, 8)}</div>
                <div style={{ fontSize: 11, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
                  {t("v2.friends.members", { n: c.member_count })}
                </div>
              </div>
            </div>
          ))
        )}

        {tab === "pending" && (
          pending.length === 0 ? (
            <div style={{ color: "var(--susu-ink-subtle)", padding: "var(--susu-s-4)", fontSize: 13 }}>
              {t("v2.friends.empty.pending")}
            </div>
          ) : pending.map(p => (
            <PendingRow key={p.request_id} req={p} onAccepted={onChange} />
          ))
        )}
      </div>
    </div>
  );
}

function TabButton({ children, on, onClick }: { children: React.ReactNode; on?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: "transparent",
      border: "none",
      borderBottom: `2px solid ${on ? "var(--susu-accent)" : "transparent"}`,
      padding: "var(--susu-s-3) var(--susu-s-3)",
      fontFamily: "var(--susu-mono)",
      fontSize: 11,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: on ? "var(--susu-ink)" : "var(--susu-ink-subtle)",
      cursor: "pointer",
    }}>
      {children}
    </button>
  );
}

function Count({ children }: { children: React.ReactNode }) {
  return <span style={{ marginLeft: 4, color: "var(--susu-ink-faint)" }}>{children}</span>;
}

function FriendRow({ friend, selected, onClick }: { friend: Friend; selected: boolean; onClick: () => void }) {
  const { t } = useLang();
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
        padding: "var(--susu-s-3)",
        borderRadius: "var(--susu-r-sm)",
        background: selected ? "var(--susu-surface-2)" : "transparent",
        cursor: "pointer",
        marginBottom: 2,
      }}
    >
      <Avatar seed={friend.friend_username ?? friend.friend_address} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="susu-mono" style={{ fontSize: 13, color: "var(--susu-ink)" }}>
          {friend.friend_username ? `@${friend.friend_username}` : `${friend.friend_address.slice(0, 6)}…`}
        </div>
        <div style={{ fontSize: 11, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
          {t("v2.friends.added", { ago: formatRelative(friend.created_at) })}
        </div>
      </div>
    </div>
  );
}

function PendingRow({ req, onAccepted }: { req: PendingRequest; onAccepted: () => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
      padding: "var(--susu-s-3)",
    }}>
      <Avatar seed={req.from_username ?? req.from_addr} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="susu-mono" style={{ fontSize: 13, color: "var(--susu-ink)" }}>
          {req.from_username ? `@${req.from_username}` : `${req.from_addr.slice(0, 6)}…`}
        </div>
        <div style={{ fontSize: 11, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>
          {t("v2.friends.requested", { ago: formatRelative(req.created_at) })}
        </div>
      </div>
      <button
        className="susu-btn susu-btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api({ method: "POST", path: "/friends/accept", body: { username: req.from_username, address: req.from_addr } });
            onAccepted();
          } catch (e) {
            console.error("[friends/accept]", e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("v2.friends.btn.busy") : t("v2.friends.btn.accept")}
      </button>
    </div>
  );
}

function AddFriendInput({ onAdded }: { onAdded: () => void }) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const clean = name.trim().replace(/^@/, "");
      await api({ method: "POST", path: "/friends/add", body: { username: clean } });
      setName("");
      onAdded();
    } catch (e: any) {
      setErr(e?.body?.error ?? String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ marginBottom: "var(--susu-s-3)" }}>
      <div style={{
        display: "flex", gap: "var(--susu-s-2)", alignItems: "center",
        border: "1px solid var(--susu-hairline)",
        borderRadius: "var(--susu-r-md)",
        background: "var(--susu-canvas)",
        padding: "4px 4px 4px 10px",
      }}>
        <span className="susu-mono" style={{ color: "var(--susu-ink-faint)" }}>@</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t("v2.friends.add.placeholder")}
          disabled={busy}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--susu-ink)", fontFamily: "var(--susu-mono)", fontSize: 13,
          }}
        />
        <button className="susu-btn susu-btn-sm susu-btn-primary" disabled={busy || !name.trim()}>
          {busy ? t("v2.friends.btn.busy") : t("v2.friends.add.btn")}
        </button>
      </div>
      <div style={{ fontSize: 11, color: err ? "var(--susu-neg)" : "var(--susu-ink-faint)", marginTop: 6, fontFamily: "var(--susu-mono)" }}>
        {err ?? t("v2.friends.add.help")}
      </div>
    </form>
  );
}

function DetailPanel({ address, channels }: { address: string | null; channels: ChannelGroup[] }) {
  const { t } = useLang();
  const { data: detail, loading } = usePeerDetail(address);

  if (!address) {
    return (
      <div className="susu-panel" style={{ padding: "var(--susu-s-8)", color: "var(--susu-ink-subtle)" }}>
        {t("v2.friends.detail.select")}
      </div>
    );
  }
  if (loading && !detail) {
    return (
      <div className="susu-panel" style={{ padding: "var(--susu-s-8)", color: "var(--susu-ink-subtle)" }}>
        {t("v2.friends.detail.loading")}
      </div>
    );
  }
  if (!detail || !detail.stats) {
    return (
      <div className="susu-panel" style={{ padding: "var(--susu-s-8)", color: "var(--susu-ink-subtle)" }}>
        {t("v2.friends.detail.noInteraction", { n: detail?.days ?? 30 })}
      </div>
    );
  }

  const s = detail.stats;
  const handle = s.username ? `@${s.username}` : `${s.address.slice(0, 6)}…`;
  return (
    <div className="susu-panel" style={{ padding: "var(--susu-s-5)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-4)", marginBottom: "var(--susu-s-5)" }}>
        <Avatar seed={handle} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--susu-s-2)" }}>
            <div className="susu-mono" style={{ fontSize: 18, color: "var(--susu-ink)" }}>{handle}</div>
          </div>
          <div style={{ fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)" }}>
            {s.address.slice(0, 4)}…{s.address.slice(-4)}{s.last_signal_at ? t("v2.friends.detail.lastSignal", { ago: formatRelative(s.last_signal_at) }) : " · —"}
          </div>
        </div>
      </div>

      <div className="susu-stat-grid-4" style={{
        border: "1px solid var(--susu-hairline)",
        borderRadius: "var(--susu-r-lg)",
        overflow: "hidden",
        marginBottom: "var(--susu-s-5)",
      }}>
        <StatCell label={t("v2.friends.detail.signalsLabel", { n: detail.days })} value={s.signal_count} meta={s.avg_conv != null ? t("v2.friends.detail.avgConv", { n: s.avg_conv.toFixed(2) }) : "—"} />
        <StatCell
          label={t("v2.friends.detail.acceptLabel")}
          value={s.accept_rate != null ? `${Math.round(s.accept_rate * 100)}%` : "—"}
          meta={`${s.accepted_signals} / ${s.signal_count}`}
        />
        <StatCell
          label={t("v2.friends.detail.realised")}
          value={<span style={{ color: s.realized_pnl_usd >= 0 ? "var(--susu-pos)" : "var(--susu-neg)" }}>{formatPnl(s.realized_pnl_usd)}</span>}
          meta={t("v2.friends.detail.closes", { n: s.closes })}
        />
        <StatCell
          label={t("v2.friends.detail.winRate")}
          value={s.win_rate != null ? `${Math.round(s.win_rate * 100)}%` : "—"}
          meta={t("v2.friends.detail.wl", { w: s.wins, l: s.losses })}
          last
        />
      </div>

      <div style={{ marginBottom: "var(--susu-s-3)" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          marginBottom: "var(--susu-s-3)",
        }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{t("v2.friends.detail.recentTitle", { handle })}</div>
          <div style={{ fontFamily: "var(--susu-mono)", fontSize: 11, color: "var(--susu-ink-subtle)" }}>
            {t("v2.friends.detail.recentAux", { n: detail.recent_signals.length, d: detail.days })}
          </div>
        </div>
        <div style={{ border: "1px solid var(--susu-hairline)", borderRadius: "var(--susu-r-md)", overflow: "hidden" }}>
          {detail.recent_signals.length === 0 ? (
            <div className="susu-empty">{t("v2.friends.detail.recentEmpty")}</div>
          ) : detail.recent_signals.map(sig => (
            <SignalRow key={sig.signal_id} sig={sig} />
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: "var(--susu-s-2)" }}>{t("v2.friends.detail.shared")}</div>
        {channels.length === 0 ? (
          <div style={{ color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)", fontSize: 12 }}>
            {t("v2.friends.detail.sharedHint")}
          </div>
        ) : (
          channels.slice(0, 5).map(c => (
            <div key={c.channel_id} style={{
              display: "flex", alignItems: "center", gap: "var(--susu-s-3)",
              padding: "var(--susu-s-2) 0",
            }}>
              <div className="susu-avatar">#</div>
              <div style={{ flex: 1 }}>
                <div className="susu-mono" style={{ fontSize: 12 }}>{c.name ?? c.channel_id.slice(0, 8)}</div>
                <div style={{ fontSize: 10, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)" }}>{t("v2.friends.members", { n: c.member_count })}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatCell({ label, value, meta, last }: { label: string; value: React.ReactNode; meta?: React.ReactNode; last?: boolean }) {
  return (
    <div style={{
      padding: "var(--susu-s-4) var(--susu-s-4)",
      borderRight: last ? "none" : "1px solid var(--susu-hairline)",
    }}>
      <div className="susu-kpi-label">{label}</div>
      <div className="susu-mono" style={{ fontSize: 20, fontWeight: 500, color: "var(--susu-ink)", marginTop: 4 }}>
        {value}
      </div>
      {meta != null && (
        <div style={{ fontSize: 11, color: "var(--susu-ink-subtle)", fontFamily: "var(--susu-mono)", marginTop: 4 }}>
          {meta}
        </div>
      )}
    </div>
  );
}

function SignalRow({ sig }: { sig: any }) {
  const side = sig.payload?.side ?? sig.payload?.direction ?? "?";
  const token = sig.payload?.token ?? sig.payload?.asset ?? sig.payload?.symbol ?? "?";
  const entry = sig.payload?.entry ?? sig.payload?.entry_price ?? sig.payload?.price;
  const note = sig.payload?.note ?? sig.payload?.reason;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "auto auto auto 1fr auto", gap: "var(--susu-s-3)",
      padding: "var(--susu-s-3) var(--susu-s-4)",
      borderBottom: "1px solid var(--susu-hairline)",
      fontFamily: "var(--susu-mono)", fontSize: 12,
      alignItems: "center",
    }}>
      <span style={{ color: "var(--susu-ink-subtle)" }}>{formatRelative(sig.created_at)}</span>
      <span className="susu-mono" style={{ color: "var(--susu-ink)" }}>{token}</span>
      <Tag kind={side === "short" ? "short" : "long"}>{String(side).toUpperCase()}</Tag>
      <span style={{ color: "var(--susu-ink-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {entry != null ? `entry ${entry}` : ""}{note ? `  ·  ${note}` : ""}
      </span>
      <span style={{
        color: sig.my_reaction_value === 1 ? "var(--susu-pos)" : sig.my_reaction_value === -1 ? "var(--susu-neg)" : "var(--susu-ink-faint)",
      }}>
        {sig.my_reaction_value === 1 ? "+1" : sig.my_reaction_value === -1 ? "-1" : "—"}
      </span>
    </div>
  );
}
