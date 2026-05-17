// All data hooks for the v2 redesigned dashboard.
// Connects directly to the real Susurration backend — no mocks, no
// placeholders. Each hook owns one logical data stream.
//
// Polling cadences are chosen for "feels alive" without burning the server:
//   - prices             1.5s   (Bloomberg-tape speed)
//   - positions          2s     (mark uses prices, so this is for state churn)
//   - book snapshot      10s    (KPIs change slowly)
//   - daemon state       8s     (config rarely changes)
//   - peers / friends    30s    (very slow churn)
// SSE stream replaces feed polling once connected.

import { useEffect, useRef, useState, useCallback } from "react";
import { api, ApiError, apiBase, session } from "../api";

// ── shared types ─────────────────────────────────────────────────────────

export interface BookSnapshot {
  initial_balance_usd: number;
  realized_pnl_total: number;
  open_count: number;
  closed_count: number;
  wins: number;
  losses: number;
  break_even: number;
  win_rate: number | null;
  signals_received_24h: number;
  signals_received_30d: number;
  accepted_24h: number;
  accepted_30d: number;
  accept_rate_24h: number | null;
  accept_rate_30d: number | null;
}

export interface EquityPoint {
  day: string;                  // ISO date (YYYY-MM-DD)
  realized_cumulative_usd: number;
}

export interface EquityResponse {
  initial_balance_usd: number;
  days: number;
  points: EquityPoint[];
}

export interface Position {
  position_id: string;
  address: string;
  signal_id: string;
  channel_id: string;
  token: string;
  direction: "long" | "short";
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  position_usd: number;
  size_factor: number | null;
  peer_username: string | null;
  is_replay: boolean;
  opened_at: string;
  closed_at: string | null;
  exit_reason: string | null;
  exit_price: number | null;
  exit_pnl_pct: number | null;
  exit_pnl_usd: number | null;
  /** Phase 18.2 — paper = susurration's simulator; live = real broker trade
   *  the agent executed and reported back. Pre-18.2 rows are paper. */
  mode: "paper" | "live";
  broker_position_id: string | null;
}

/** Phase 18.2 — dashboard selector for showing paper / live / both books. */
export type ModeFilter = "all" | "paper" | "live";

export interface DaemonState {
  status: "online" | "stale" | "never_seen";
  last_ping_at: string | null;
  seconds_since_ping: number | null;
  version: string | null;
  provider: string | null;
  execution_mode: "paper" | "live" | null;
  broker_connected: boolean | null;
  conv_threshold: number | null;
  min_size_factor: number | null;
  started_at: string | null;
  uptime_seconds: number | null;
}

export interface PeerStat {
  address: string;
  username: string | null;
  signal_count: number;
  avg_conv: number | null;
  top_assets: string[];
  accepted_signals: number;
  accept_rate: number | null;
  realized_pnl_usd: number;
  win_rate: number | null;
  opens: number;
  closes: number;
  wins: number;
  losses: number;
  last_signal_at: string | null;
}

export interface PeerStatsResponse { days: number; peers: PeerStat[]; }

export interface PeerDetailSignal {
  signal_id: string;
  channel_id: string;
  channel_name: string | null;
  payload: any;
  created_at: string;
  my_reaction_value: number | null;
}

export interface PeerDetailResponse {
  days: number;
  address: string;
  stats: PeerStat | null;
  recent_signals: PeerDetailSignal[];
}

export interface Friend {
  friend_address: string;
  friend_username: string | null;
  channel_id: string;
  created_at: string;
}

export interface PendingRequest {
  request_id: string;
  from_addr: string;
  from_username: string | null;
  created_at: string;
}

export interface ChannelGroup {
  channel_id: string;
  name: string | null;
  owner: string | null;
  is_group: boolean;
  member_count: number;
  created_at: string;
}

export interface FeedItem {
  kind: string;
  signal_id: string | null;
  reaction_id: string | null;
  parent_signal_id?: string | null;
  channel_id: string;
  from_address: string;
  from_username: string | null;
  payload: any;
  created_at: string;
  channel_name: string | null;
  is_group?: boolean;
  peer?: { address: string; username: string | null };
  is_auto?: boolean;
}

export interface WhoAmI {
  address: string;
  username: string | null;
  auto_accept_friends: boolean;
  created_at: string;
  last_mcp_ping_at: string | null;
  last_daemon_ping_at: string | null;
  last_daemon_version: string | null;
}

export interface Prices { prices: Record<string, number>; }

// ── generic poll hook ────────────────────────────────────────────────────
//
// Phase 18.2-w perf — module-level cache keyed by path implements SWR
// (stale-while-revalidate): switching v2 tabs no longer wipes data + shows
// "loading…" while the next fetch round-trips. New hook instance reads
// last-known data instantly, then fetches in the background and updates.
// In-flight requests are deduplicated by path so two components mounting
// at the same time hit the network once.
//
// Cache survives across route changes for the lifetime of the page. Token
// changes (sign-out) wipe it via api.session.clear → see api.ts.

const pollCache = new Map<string, { data: unknown; ts: number }>();
const inflight = new Map<string, Promise<unknown>>();

// Every active usePoll subscriber registers a refetch callback here so that
// (a) visibilitychange "visible" can wake all of them at once and
// (b) SSE reconnects can ask the feed/peers/etc. to re-snapshot.
// Module-level (not React context) so it lives across mount/unmount cycles.
const visibilityRefetchers = new Set<() => void>();

// ── Persistent SWR layer ────────────────────────────────────────────────
//
// Memory cache only survives within a single page lifetime; reload nukes it
// and the user sees a 1-2 second "empty dashboard" while every endpoint
// re-fetches in parallel. We mirror small endpoint responses into
// localStorage so a hard refresh can paint the last-known snapshot
// instantly, then background-revalidate. Big endpoints (feed/* with their
// 500-event payloads, /prices with its tick churn) skip the persist layer
// — feed is reconstructed by SSE and prices change too fast to be useful
// stale.
const PERSIST_PREFIX = "susu.v2.cache:";
// Per-entry size cap. 100 KB is plenty for any snapshot we care about and
// keeps a runaway response from eating the entire 5-10 MB localStorage
// budget. Computed lazily because TextEncoder isn't free on every write.
const PERSIST_MAX_BYTES = 100_000;
// How long a stored snapshot is allowed to be served as the initial paint.
// We still revalidate immediately in the background — this is just a
// guard against a user reopening a tab after a week of laptop-sleep and
// seeing dashboard content from a week ago. 24h chosen so overnight tab
// reopens still benefit, but a long-abandoned tab triggers a clean reload.
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Endpoints we deliberately keep memory-only. signals/feed payload is too
// large and SSE owns its replay; prices change too fast to be useful from
// disk.
const PERSIST_SKIP_PREFIXES = ["/signals/feed", "/prices", "/auth/stream-token"];

function shouldPersist(path: string): boolean {
  return !PERSIST_SKIP_PREFIXES.some(p => path.startsWith(p));
}

function loadPersisted<T>(path: string): { data: T; ts: number } | null {
  if (!shouldPersist(path)) return null;
  try {
    const raw = localStorage.getItem(PERSIST_PREFIX + path);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; ts: number };
    if (typeof parsed?.ts !== "number") return null;
    if (Date.now() - parsed.ts > PERSIST_MAX_AGE_MS) {
      // Stale beyond our serve window. Drop it so we don't paint week-old
      // numbers as if they were current.
      localStorage.removeItem(PERSIST_PREFIX + path);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(path: string, data: unknown): void {
  if (!shouldPersist(path)) return;
  try {
    const payload = JSON.stringify({ data, ts: Date.now() });
    if (payload.length > PERSIST_MAX_BYTES) return;  // skip oversized
    localStorage.setItem(PERSIST_PREFIX + path, payload);
  } catch {
    // localStorage quota / private mode / SecurityError — degrade silently
    // to memory-only behaviour. Don't try to evict here; the user will
    // bounce back fine on the next session.set() clear.
  }
}

/** Purge every persisted cache entry. Called from session.clear() on
 *  sign-out and from session.set() when a different account logs in
 *  (cross-account pollution prevention). */
export function clearPersistedCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PERSIST_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* never fatal */ }
}

let visibilityListenerInstalled = false;
function ensureVisibilityListener(): void {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  visibilityListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Tab just came back; setInterval may have been throttled to once per
      // minute or longer in the background, so the on-screen data can be
      // stale by an arbitrary amount. Fire every active refetcher to catch
      // the UI up before the user can perceive the lag.
      for (const fn of visibilityRefetchers) fn();
    }
  });
}

export function clearPollCache(): void {
  pollCache.clear();
  inflight.clear();
  clearPersistedCache();
}
// Expose on window so api.ts session.clear can drop our cache without
// a circular import at module-load time.
if (typeof window !== "undefined") {
  (window as any).__susuClearPollCache = clearPollCache;
}

function usePoll<T>(
  path: string | null,
  intervalMs: number,
  enabled: boolean = true,
): { data: T | null; error: ApiError | null; loading: boolean; refetch: () => void } {
  // Seed state from cache so a fresh-mount component renders prior data
  // immediately instead of flashing a loading state.
  //   1. memory cache wins (same page lifetime)
  //   2. fall back to localStorage snapshot from a previous tab/session
  // Either way, we always trigger a background fetch — the seed is just
  // there to keep the UI populated during the round-trip.
  let seed: T | undefined;
  if (path) {
    const mem = pollCache.get(path);
    if (mem) {
      seed = mem.data as T;
    } else {
      const persisted = loadPersisted<T>(path);
      if (persisted) {
        seed = persisted.data;
        // Hydrate memory cache so peer components mounting in the same
        // page lifetime hit memory, not localStorage, on subsequent reads.
        pollCache.set(path, { data: persisted.data, ts: persisted.ts });
      }
    }
  }
  const [data, setData] = useState<T | null>(seed ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(seed === undefined);
  // mountedRef guards setState calls from in-flight fetches that resolve
  // after the component unmounts (common on rapid tab switches now that
  // the cache makes navigation feel instant). Without it React warns
  // "state update on a component that hasn't mounted yet" and burns CPU
  // on phantom re-renders.
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async () => {
    if (!path || !enabled) return;
    // Dedupe: if another component already has an in-flight request for
    // this path, attach to it instead of issuing a parallel call.
    let pending = inflight.get(path) as Promise<T> | undefined;
    if (!pending) {
      pending = api<T>({ path });
      inflight.set(path, pending as Promise<unknown>);
      pending.finally(() => {
        if (inflight.get(path) === pending) inflight.delete(path);
      });
    }
    try {
      // Client-side timeout sleeve. Without it a stalled connection
      // (mid-stream RST, proxy black-hole, browser conn-pool starvation
      // under SSE + parallel polls, etc.) leaves the await pending
      // forever, which leaves the consumer's loading state pinned at
      // true with no error to act on. 15s is well past the p99 of the
      // endpoints we call here (peers/stats was the previous slowest
      // at ~24s before MAX_DAYS got capped to 120; everything else is
      // sub-second). If a real request needs more, the next interval
      // tick will retry.
      const res = await Promise.race<T>([
        pending as Promise<T>,
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new ApiError(0, "client_timeout", path)),
            15_000,
          ),
        ),
      ]);
      pollCache.set(path, { data: res, ts: Date.now() });
      // Mirror to localStorage so the next cold reload can paint this
      // value before the network round-trip completes.
      savePersisted(path, res);
      if (!mountedRef.current) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof ApiError) setError(e);
      else setError(new ApiError(0, String(e), path));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!path || !enabled) return;
    if (pollCache.has(path)) {
      setData(pollCache.get(path)!.data as T);
      setLoading(false);
    } else {
      // Memory missed, but localStorage may still have a snapshot from a
      // previous session — hydrate it before the network call resolves.
      const persisted = loadPersisted<T>(path);
      if (persisted) {
        pollCache.set(path, { data: persisted.data, ts: persisted.ts });
        setData(persisted.data);
        setLoading(false);
      }
    }
    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    // Register in the visibility-driven refetch set. When the tab comes
    // back to the foreground after a long idle, the runtime fires every
    // registered fn so the user sees fresh data immediately instead of
    // waiting for the next setInterval tick (which may have been
    // throttled to once per minute in the background).
    ensureVisibilityListener();
    visibilityRefetchers.add(fetchOnce);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
      visibilityRefetchers.delete(fetchOnce);
    };
  }, [path, intervalMs, enabled, fetchOnce]);

  return { data, error, loading, refetch: fetchOnce };
}

// ── concrete hooks ───────────────────────────────────────────────────────

export function useWhoAmI() {
  return usePoll<WhoAmI>("/identity/whoami", 60_000);
}

export function useBookSnapshot(mode: ModeFilter = "all") {
  const q = mode === "all" ? "" : `?mode=${mode}`;
  return usePoll<BookSnapshot>(`/book/snapshot${q}`, 10_000);
}

export function useBookEquity(days: number = 21, mode: ModeFilter = "all") {
  const modeQ = mode === "all" ? "" : `&mode=${mode}`;
  return usePoll<EquityResponse>(`/book/equity?days=${days}${modeQ}`, 60_000);
}

export function useOpenPositions(mode: ModeFilter = "all") {
  // Server endpoint returns the raw position rows; we want them with marks
  // overlaid client-side via /prices, so we keep this thin.
  const q = mode === "all" ? "status=open" : `status=open&mode=${mode}`;
  return usePoll<{ positions: Position[] }>(`/positions/mine?${q}`, 5_000);
}

export function useDaemonState() {
  return usePoll<DaemonState>("/daemon/state", 8_000);
}

export function usePeersStats(days: number = 30) {
  return usePoll<PeerStatsResponse>(`/peers/stats?days=${days}`, 30_000);
}

// ── daemon upgrade hook ──────────────────────────────────────────────────
//
// Phase 18.2-w (lazy-probe rewrite) — port of the v0 dashboard's
// UpgradeBanner state machine, but the daemon localhost probe now ONLY
// happens after the user clicks the upgrade button. Why: a HTTPS dashboard
// page fetching http://127.0.0.1:7777 triggers a mixed-content / CORS
// permission prompt in some browsers, which felt jarring when the banner
// label was already "Copy upgrade cmd" (the user didn't ask for one-click,
// so why is the browser asking for permission?). Single click does the
// right thing: try daemon → success: kick /upgrade. fail: copy cmd to
// clipboard + tell the user to paste it.

export type UpgradeState = "idle" | "upgrading" | "polling" | "done" | "copied" | "error";

export interface UpgradeStatus {
  currentVersion: string | null;
  latestVersion: string | null;
  needsUpgrade: boolean;
  state: UpgradeState;
  error: string | null;
  /** Single user-facing trigger. Probes daemon lazily; falls back to
   *  clipboard copy if daemon isn't reachable. */
  triggerUpgrade: () => Promise<void>;
  installerCmd: string;
}

const DAEMON_LOCAL_BASE = "http://127.0.0.1:7777";

function semverLT(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

export function useDaemonUpgrade(): UpgradeStatus {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpgradeState>("idle");
  const [error, setError] = useState<string | null>(null);

  // 1. Fetch our daemon version + npm latest in parallel. These are normal
  //    HTTPS API calls to the backend, no mixed-content concerns. Localhost
  //    probe happens later, only after the user clicks (see triggerUpgrade).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ last_daemon_version: string | null }>({ path: "/identity/whoami" }).catch(() => ({ last_daemon_version: null })),
      api<{ version: string | null }>({ path: "/daemon/latest-version" }).catch(() => ({ version: null })),
    ]).then(([me, latest]) => {
      if (cancelled) return;
      setCurrentVersion(me.last_daemon_version ?? null);
      setLatestVersion(latest.version ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  const needsUpgrade =
    currentVersion != null &&
    latestVersion != null &&
    semverLT(currentVersion, latestVersion);

  const installerCmd = ` npx -y @susurration/installer install --token ${session.token ?? "sk_live_YOUR_TOKEN"}`;

  /** Copy the installer command to the clipboard. Used as fallback when
   *  the daemon localhost probe fails (daemon on a different machine /
   *  not running / pre-Phase-17 with no /healthz). */
  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(installerCmd);
      setState("copied");
      // Auto-reset after 3s so a follow-up click can try again.
      setTimeout(() => {
        setState((s) => (s === "copied" ? "idle" : s));
      }, 3000);
    } catch {
      // Clipboard API blocked (rare — usually permission required only on
      // first interaction). Surface a hint so the user knows to select the
      // command manually.
      setState("error");
      setError("Clipboard blocked — select the command in your terminal manually.");
    }
  }, [installerCmd]);

  const triggerUpgrade = useCallback(async () => {
    setError(null);

    api({ path: "/onboarding/event", method: "POST", body: {
      action: "upgrade_banner_click",
      context: { current: currentVersion, latest: latestVersion, path: "click_pending_probe" },
    } }).catch(() => {});

    // Lazy probe — only NOW do we touch localhost. If the daemon isn't
    // reachable on this machine, fall back to clipboard copy without ever
    // exposing the mixed-content request shape to passive page loads.
    let oneClickReady = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`${DAEMON_LOCAL_BASE}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const data = await r.json().catch(() => null) as any;
        oneClickReady = !!data && typeof data.upgrade_endpoint === "string";
      }
    } catch {
      // Network error / mixed-content denial / daemon not running.
      // All map to: "this user doesn't have a local upgradeable daemon
      // here, so we should copy the command instead."
    }

    if (!oneClickReady) {
      await copyToClipboard();
      // Telemetry: copy path.
      api({ path: "/onboarding/event", method: "POST", body: {
        action: "upgrade_banner_click",
        context: { current: currentVersion, latest: latestVersion, path: "copy" },
      } }).catch(() => {});
      return;
    }

    // One-click path. Same state machine as v0.
    setState("upgrading");
    api({ path: "/onboarding/event", method: "POST", body: {
      action: "upgrade_banner_click",
      context: { current: currentVersion, latest: latestVersion, path: "one_click" },
    } }).catch(() => {});

    // Send the upgrade kick to the local daemon. npm install can take 30-60s
    // on a cold cache; 150s upper bound matches v0.
    let upgradeResp: any = null;
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 150_000);
      const r = await fetch(`${DAEMON_LOCAL_BASE}/upgrade`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);
      upgradeResp = await r.json().catch(() => null);
      if (!r.ok) {
        setState("error");
        setError(upgradeResp?.error ? `${upgradeResp.error}${upgradeResp.hint ? ": " + upgradeResp.hint : ""}` : `HTTP ${r.status}`);
        return;
      }
    } catch (err) {
      setState("error");
      setError((err as Error).message ?? "request failed");
      return;
    }

    // already_latest path. Three sub-cases — same as v0 UpgradeBanner.
    if (upgradeResp?.status === "already_latest") {
      try {
        const me = await api<{ last_daemon_version: string | null }>({ path: "/identity/whoami" });
        let serverVersion = me.last_daemon_version;
        if (serverVersion && latestVersion && !semverLT(serverVersion, latestVersion)) {
          setState("done");
          setCurrentVersion(serverVersion);
          return;
        }
        await new Promise((r) => setTimeout(r, 5_000));
        const me2 = await api<{ last_daemon_version: string | null }>({ path: "/identity/whoami" }).catch(() => null);
        serverVersion = me2?.last_daemon_version ?? serverVersion;
        if (serverVersion && latestVersion && !semverLT(serverVersion, latestVersion)) {
          setState("done");
          setCurrentVersion(serverVersion);
          return;
        }
        if (!serverVersion) {
          // Case C — server hasn't seen the daemon yet. Trust daemon self-report.
          setState("done");
          setCurrentVersion(latestVersion);
          return;
        }
        setState("error");
        setError(`Daemon claims latest but server records v${serverVersion} — restart daemon manually`);
      } catch {
        setState("error");
        setError("Could not verify upgrade status");
      }
      return;
    }

    // Normal upgrade path. Poll /healthz until version bumps or 60s timeout.
    setState("polling");
    const pollDeadline = Date.now() + 60_000;
    const target = latestVersion;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const hc = await fetch(`${DAEMON_LOCAL_BASE}/healthz`, { signal: ctrl.signal });
        clearTimeout(t);
        if (hc.ok) {
          const data = await hc.json() as { version?: string };
          if (data.version && target && !semverLT(data.version, target) && data.version !== currentVersion) {
            setState("done");
            setCurrentVersion(data.version);
            return;
          }
        }
      } catch { /* still restarting */ }
    }
    setState("error");
    setError("Daemon did not start within 60s after upgrade — restart manually");
  }, [currentVersion, latestVersion, copyToClipboard]);

  return {
    currentVersion,
    latestVersion,
    needsUpgrade,
    state,
    error,
    triggerUpgrade,
    installerCmd,
  };
}

export function usePeerDetail(address: string | null, days: number = 30) {
  return usePoll<PeerDetailResponse>(
    address ? `/peers/${encodeURIComponent(address)}/stats?days=${days}` : null,
    20_000,
    !!address,
  );
}

export function useFriends() {
  return usePoll<{ friends: Friend[] }>("/friends", 30_000);
}

export function usePendingRequests() {
  return usePoll<{ requests: PendingRequest[] }>("/friends/requests", 30_000);
}

export function useChannelGroups() {
  return usePoll<{ groups: ChannelGroup[] }>("/channels/groups", 30_000);
}

export interface ChannelMember {
  address: string;
  username: string | null;
  joined_at: string;
}

export function useChannelMembers(channelId: string | null) {
  return usePoll<{ members: ChannelMember[] }>(
    channelId ? `/channels/${encodeURIComponent(channelId)}/members` : null,
    60_000,
    channelId != null,
  );
}

export interface ChannelDetail {
  channel_id: string;
  name: string | null;
  created_by: string;
  owner: string;
  is_group: boolean;
  meta: Record<string, any> | null;
  created_at: string;
}

export function useChannelDetail(channelId: string | null) {
  return usePoll<ChannelDetail>(
    channelId ? `/channels/${encodeURIComponent(channelId)}` : null,
    60_000,
    channelId != null,
  );
}

export interface ChannelStatsResponse {
  channel_id: string;
  days: number;
  stats: {
    signal_count: number;
    distinct_pushers: number;
    avg_conv: number | null;
    last_signal_at: string | null;
    accepted_signals: number;
    accept_rate: number | null;
    opens: number;
    closes: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    realized_pnl_usd: number;
  };
  top_pushers: { address: string; username: string | null; count: number }[];
  recent_signals: {
    signal_id: string;
    from_address: string;
    from_username: string | null;
    payload: any;
    created_at: string;
    my_reaction_value: number | null;
  }[];
}

export function useChannelStats(channelId: string | null, days: number = 30) {
  return usePoll<ChannelStatsResponse>(
    channelId ? `/channels/${encodeURIComponent(channelId)}/stats?days=${days}` : null,
    30_000,
    channelId != null,
  );
}

export function useSignalFeed(limit: number = 200) {
  return usePoll<{ signals: FeedItem[]; count: number; limit: number }>(
    `/signals/feed?limit=${limit}`,
    20_000,
  );
}

// ── prices (one HTTP call for current mark per token) ────────────────────

export function usePrices(symbols: string[], intervalMs: number = 1500) {
  // Symbol list is keyed by sorted order so the hook restarts only when the
  // set changes, not on render-stable arrays with different identity.
  const key = symbols.slice().sort().join(",");
  return usePoll<Prices>(key ? `/prices?symbols=${encodeURIComponent(key)}` : null, intervalMs, key.length > 0);
}

// ── SSE feed stream — replaces poll once connected ──────────────────────

export interface SSEFeedState {
  events: FeedItem[];                          // newest first
  status: "idle" | "connecting" | "open" | "error";
  error: string | null;
}

export function useFeedSSE(initial: FeedItem[]) {
  const [state, setState] = useState<SSEFeedState>({
    events: initial,
    status: "idle",
    error: null,
  });
  // Seed events the FIRST time `initial` arrives non-empty. After that, SSE
  // is the source of truth; we ignore subsequent polled snapshots so a new
  // array identity from the parent poll doesn't loop us.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || initial.length === 0) return;
    seededRef.current = true;
    setState(s => ({ ...s, events: initial }));
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect() {
      if (cancelled) return;
      attempt += 1;
      // Exponential backoff capped at 30s. 1s, 2s, 4s, 8s, 16s, 30s, 30s…
      const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));
      reconnectTimer = setTimeout(connect, delay);
    }

    async function connect() {
      reconnectTimer = null;
      if (cancelled) return;
      try {
        setState(s => ({ ...s, status: "connecting", error: null }));
        // Mint a short-lived stream token (EventSource can't send headers).
        const tok = await api<{ token: string }>({
          path: "/auth/stream-token",
          method: "POST",
        });
        if (cancelled) return;
        const url = apiBase.replace(/\/$/, "") + `/signals/feed/stream?stream_token=${encodeURIComponent(tok.token)}`;
        es = new EventSource(url);
        es.onopen = () => {
          if (cancelled) return;
          attempt = 0;  // success — reset backoff
          setState(s => ({ ...s, status: "open", error: null }));
          // When the stream comes back from a disconnect (mobile sleep,
          // wifi blip, etc.), polled views (positions / book / friends)
          // may also be stale. Nudge every active usePoll subscriber to
          // re-snapshot so the rest of the UI catches up alongside the
          // resumed stream.
          for (const fn of visibilityRefetchers) fn();
        };
        es.onerror = () => {
          if (cancelled) return;
          setState(s => ({ ...s, status: "error", error: "stream disconnected" }));
          // EventSource will auto-reconnect on its own, but only while the
          // page is foregrounded — backgrounded tabs see it stay dead.
          // Close + manually retry with our own backoff so we drive the
          // reconnect ourselves and it works regardless of visibility.
          es?.close();
          es = null;
          scheduleReconnect();
        };
        const ingest = (e: MessageEvent) => {
          if (cancelled || !e.data) return;
          try {
            const parsed = JSON.parse(e.data) as FeedItem;
            setState(s => ({ ...s, events: [parsed, ...s.events].slice(0, 500) }));
          } catch { /* malformed event */ }
        };
        ["signal", "reaction", "channel_member_added", "channel_member_removed", "channel_meta_changed", "channel_owner_transferred"].forEach(t => es!.addEventListener(t, ingest as any));
      } catch (e) {
        if (cancelled) return;
        setState(s => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }));
        scheduleReconnect();
      }
    }

    // Tab-visibility hook — if the stream went into error / connecting state
    // while the tab was hidden, force a fresh connect the moment it comes
    // back. Cheap (token mint + EventSource open ~150ms) and avoids the
    // user staring at stale data until the next backoff tick fires.
    function onVisibilityChange() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (es && es.readyState === EventSource.OPEN) return;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      attempt = 0;
      connect();
    }

    if (session.token) connect();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      cancelled = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      es?.close();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, []);

  return state;
}

// ── small helpers ────────────────────────────────────────────────────────

export function pnlOf(p: Position, mark: number): number {
  const dir = p.direction === "long" ? 1 : -1;
  return ((mark - p.entry_price) / p.entry_price) * p.position_usd * p.leverage * dir;
}

export function durationStr(fromIso: string, nowMs: number = Date.now()): string {
  const ms = nowMs - new Date(fromIso).getTime();
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatMoney(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPnl(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? "+$" : "-$") + abs;
}

export function formatPercent(n: number, digits: number = 2): string {
  return (n >= 0 ? "+" : "") + (n * 100).toFixed(digits) + "%";
}
