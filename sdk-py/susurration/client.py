"""SusuClient — sync HTTP client. SSE streaming via httpx.stream.

Mirrors the D13 backend surface (post open-protocol-framework + non-custodial
billing). See ``susu doc`` (CLI) or the MCP server's ``instructions`` field
for the canonical AGENT_DOC.
"""
from __future__ import annotations

import json
from typing import Any, Iterator, Mapping

import base58
import httpx
import nacl.signing

from .errors import InsufficientAllowanceError, SusurrationError


def _strip_at(handle: str) -> str:
    """Accept either ``@bob`` or ``bob``."""
    return handle[1:] if handle.startswith("@") else handle


class SusuClient:
    """Susurration API client.

    Auth modes (mutually exclusive):
      - Pre-issued ``token``: skip ``login()``.
      - ``secret_key_b58 + address``: call ``login()`` to exchange for a token.

    Sync API by design — agents are already on threads, no benefit to forcing
    async. SSE streaming uses httpx.stream which is sync-iterable.
    """

    def __init__(
        self,
        api_url: str = "http://localhost:8787/api",
        token: str | None = None,
        secret_key_b58: str | None = None,
        address: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.address = address
        self._secret_key_b58 = secret_key_b58
        self._http = httpx.Client(timeout=timeout)

    # ── auth ─────────────────────────────────────────────────────────

    def login(self) -> dict:
        if not self.address or not self._secret_key_b58:
            raise ValueError("login() requires address + secret_key_b58")
        nonce = self._req("POST", "/auth/nonce", {"address": self.address}, auth=False)
        secret = base58.b58decode(self._secret_key_b58)
        # SigningKey accepts the 32-byte seed; nacl 64-byte secret = seed||pubkey,
        # so we slice the seed off the front.
        seed = secret[:32]
        signing_key = nacl.signing.SigningKey(seed)
        sig = signing_key.sign(nonce["message"].encode("utf-8")).signature
        verify = self._req(
            "POST", "/auth/verify",
            {
                "address": self.address,
                "nonce": nonce["nonce"],
                "signature_b58": base58.b58encode(sig).decode("ascii"),
            },
            auth=False,
        )
        self.token = verify["token"]
        return verify

    # ── identity ─────────────────────────────────────────────────────

    def whoami(self) -> dict:
        return self._req("GET", "/identity/whoami")

    def register(self, username: str) -> dict:
        """Lock a permanent username for the authed address. Format
        ``[a-z0-9_-]{3,20}``. Once set, cannot be changed."""
        return self._req("POST", "/identity/register", {"username": _strip_at(username)})

    def by_username(self, username: str) -> dict:
        """Public lookup — resolve ``@handle`` → ``{address, username}``. No auth."""
        return self._req("GET", f"/identity/by-username/{_strip_at(username)}", auth=False)

    # ── friends (1-on-1 channels) ───────────────────────────────────

    def friends_add(self, *, username: str | None = None, address: str | None = None) -> dict:
        """Add a friend by ``@handle`` or address. If their auto_accept is on,
        a 1-on-1 channel is created and ``channel_id`` is returned. Otherwise
        a pending request is recorded."""
        body: dict[str, Any] = {}
        if username is not None: body["username"] = _strip_at(username)
        if address is not None: body["address"] = address
        return self._req("POST", "/friends/add", body)

    def friends_accept(self, *, username: str | None = None, address: str | None = None) -> dict:
        """Accept a pending friend request — only when your auto_accept is off."""
        body: dict[str, Any] = {}
        if username is not None: body["username"] = _strip_at(username)
        if address is not None: body["address"] = address
        return self._req("POST", "/friends/accept", body)

    def friends_remove(self, *, username: str | None = None, address: str | None = None) -> dict:
        body: dict[str, Any] = {}
        if username is not None: body["username"] = _strip_at(username)
        if address is not None: body["address"] = address
        return self._req("POST", "/friends/remove", body)

    def friends(self) -> dict:
        """List current friends (each with channel_id)."""
        return self._req("GET", "/friends")

    def friends_requests(self) -> dict:
        """Pending incoming friend requests."""
        return self._req("GET", "/friends/requests")

    # ── channels (groups) ─────────────────────────────────────────────

    def create_channel(self, name: str | None = None) -> dict:
        """Create a GROUP channel. Caller is owner + only initial member."""
        return self._req("POST", "/channels", {"name": name})

    def get_channel(self, channel_id: str) -> dict:
        return self._req("GET", f"/channels/{channel_id}")

    def list_members(self, channel_id: str) -> dict:
        return self._req("GET", f"/channels/{channel_id}/members")

    def invite(self, channel_id: str, address: str) -> dict:
        """Group only. 1-on-1 channels return 409 not_supported_for_1on1."""
        return self._req("POST", f"/channels/{channel_id}/invite", {"address": address})

    def leave(self, channel_id: str) -> dict:
        """1-on-1: cascade-deletes the channel.
        Group: regular leave; if owner leaves, server auto-elects the
        earliest-joined remaining member as new owner."""
        return self._req("POST", f"/channels/{channel_id}/leave")

    def kick(self, channel_id: str, address: str) -> dict:
        """Group only, owner only. No server-side cooldown."""
        return self._req("POST", f"/channels/{channel_id}/kick", {"address": address})

    def transfer_owner(
        self,
        channel_id: str,
        *,
        username: str | None = None,
        candidate_address: str | None = None,
    ) -> dict:
        """Group only, owner only. Candidate must already be a member."""
        body: dict[str, Any] = {}
        if username is not None: body["username"] = _strip_at(username)
        if candidate_address is not None: body["candidate_address"] = candidate_address
        return self._req("POST", f"/channels/{channel_id}/transfer-owner", body)

    # ── channel meta KV (D13 open protocol) ─────────────────────────

    def meta_get(self, channel_id: str) -> dict:
        """Read channel meta JSON. Members can read; owner can write."""
        return self._req("GET", f"/channels/{channel_id}/meta")

    def meta_set(self, channel_id: str, meta: Mapping[str, Any]) -> dict:
        """REPLACE channel meta with the given JSON. 16KB limit. Group only,
        owner only. Use ``meta_patch`` for shallow merge."""
        return self._req("PUT", f"/channels/{channel_id}/meta", dict(meta))

    def meta_patch(self, channel_id: str, meta: Mapping[str, Any]) -> dict:
        """Shallow-merge into existing meta."""
        return self._req("PATCH", f"/channels/{channel_id}/meta", dict(meta))

    # ── signals + reactions ──────────────────────────────────────────

    def push_signal(self, channel_id: str, payload: Mapping[str, Any] | str) -> dict:
        """Push a signal. $0.01 per call; every new identity gets $5 free credits."""
        body = {"text": payload} if isinstance(payload, str) else dict(payload)
        return self._req("POST", f"/channels/{channel_id}/signals", body)

    def list_signals(self, channel_id: str, since: str | None = None, limit: int = 50) -> dict:
        q: dict[str, Any] = {"limit": limit}
        if since: q["since"] = since
        return self._req("GET", f"/channels/{channel_id}/signals", params=q)

    def stream_signals(self, channel_id: str) -> Iterator[dict]:
        """Yield signals as they arrive via SSE. Blocks until the stream closes."""
        if not self.token:
            raise ValueError("stream_signals requires a session token (call login() first)")
        # R2: mint a single-use stream_token; the bearer never hits the URL.
        st = self._req("POST", "/auth/stream-token")
        url = f"{self.api_url}/channels/{channel_id}/signals/stream"
        with self._http.stream("GET", url, params={"stream_token": st["stream_token"]}, timeout=None) as resp:
            if resp.status_code != 200:
                raise SusurrationError(resp.status_code, resp.read().decode(), url)
            event = "message"
            data_buf: list[str] = []
            for line in resp.iter_lines():
                if line == "":
                    if event == "signal" and data_buf:
                        try:
                            yield json.loads("".join(data_buf))
                        except json.JSONDecodeError:
                            pass
                    event = "message"
                    data_buf = []
                    continue
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data_buf.append(line[5:].strip())

    def push_reaction(self, signal_id: str, payload: Any, is_auto: bool = False) -> dict:
        """React to a peer's signal. $0.01 per call; every new identity gets $5 free credits."""
        return self._req("POST", f"/signals/{signal_id}/reactions", {"payload": payload, "is_auto": is_auto})

    def list_reactions(self, signal_id: str) -> dict:
        return self._req("GET", f"/signals/{signal_id}/reactions")

    # ── Phase 18.2 atomic accept / reject / close ────────────────────
    # These replace the overloaded ``push_reaction`` for trading decisions.
    # ``accept_signal`` writes a +1 reaction AND opens a position in one
    # server transaction so the audit log and the position book can't
    # diverge on a crash. ``reject_signal`` writes a -1 reaction. Paper
    # positions are auto-closed by the daemon; ``close_position`` is for
    # live mode (agent reports a broker fill back to susurration).

    def accept_signal(
        self,
        signal_id: str,
        channel_id: str,
        token: str,
        direction: str,
        leverage: float,
        entry_price: float,
        stop_loss: float,
        take_profit: float,
        position_usd: float,
        *,
        size_factor: float | None = None,
        mode: str = "paper",
        broker_position_id: str | None = None,
        peer_username: str | None = None,
        note: str | None = None,
        is_auto: bool = True,
    ) -> dict:
        """Agree with a peer's trading signal AND open the position atomically.

        Server enforces broker_position_id when mode='live'. Returns
        ``{ok, position_id, reaction_id, opened_at, mode, cost_usd,
        allowance_after}``. Idempotent on (address, signal_id).
        """
        body: dict[str, Any] = {
            "channel_id": channel_id,
            "token": token,
            "direction": direction,
            "leverage": leverage,
            "entry_price": entry_price,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "position_usd": position_usd,
            "mode": mode,
            "is_auto": is_auto,
        }
        if size_factor is not None:        body["size_factor"] = size_factor
        if broker_position_id is not None: body["broker_position_id"] = broker_position_id
        if peer_username is not None:      body["peer_username"] = peer_username
        if note is not None:               body["note"] = note
        return self._req("POST", f"/signals/{signal_id}/accept", body)

    def reject_signal(
        self,
        signal_id: str,
        note: str | None = None,
        is_auto: bool = True,
    ) -> dict:
        """Decline a peer's trading signal. Writes a -1 reaction with note;
        no position is opened."""
        body: dict[str, Any] = {"is_auto": is_auto}
        if note is not None: body["note"] = note
        return self._req("POST", f"/signals/{signal_id}/reject", body)

    def close_position(
        self,
        position_id: str,
        exit_price: float,
        exit_pnl_pct: float,
        exit_reason: str,
        *,
        exit_pnl_usd: float | None = None,
        broker_close_id: str | None = None,
        closed_at: str | None = None,
    ) -> dict:
        """Close an open position. Paper positions auto-close via the daemon;
        agents call this primarily for live positions when the broker MCP
        reports a fill so susurration's book mirrors broker truth.
        ``exit_reason`` ∈ TP / SL / TRAIL / TIME / MANUAL / broker_fill.
        """
        body: dict[str, Any] = {
            "exit_price": exit_price,
            "exit_pnl_pct": exit_pnl_pct,
            "exit_reason": exit_reason,
        }
        if exit_pnl_usd is not None:    body["exit_pnl_usd"] = exit_pnl_usd
        if broker_close_id is not None: body["broker_close_id"] = broker_close_id
        if closed_at is not None:       body["closed_at"] = closed_at
        return self._req("POST", f"/positions/{position_id}/close", body)

    # ── billing (non-custodial SPL Approve) ─────────────────────────

    def allowance(self) -> dict:
        """Read on-chain SPL allowance + rate. BETA returns
        ``{status: 'BETA — free', rate_usd_per_call: 0}``. Paid returns
        ``{allowance_usd, estimated_calls_remaining, spender_pubkey,
        approve_again_url, ...}``."""
        return self._req("GET", "/billing/allowance")

    def spender(self) -> dict:
        """Public — return the current spender pubkey + USDC mint + cluster.
        No auth required."""
        return self._req("GET", "/billing/spender", auth=False)

    def approve_tx(self, amount_usd: float = 100.0) -> dict:
        """Build an unsigned SPL Token Approve tx (base64). User must sign in
        their wallet (Phantom etc.) and submit. Direct user to
        ``https://susurration.xyz/approve?amount=N`` for the web signing flow."""
        return self._req("POST", "/billing/approve-tx", {"amount_usd": amount_usd})

    def usage(self, since: str | None = None, limit: int = 100) -> dict:
        """List recent debits. Returns ``total_calls``, ``total_cost_usd``, ``items``."""
        q: dict[str, Any] = {"limit": limit}
        if since: q["since"] = since
        return self._req("GET", "/usage", params=q)

    # ── private ──────────────────────────────────────────────────────

    def _req(
        self,
        method: str,
        path: str,
        body: Any = None,
        params: Mapping[str, Any] | None = None,
        auth: bool = True,
    ) -> dict:
        url = self.api_url + path
        headers: dict[str, str] = {"content-type": "application/json"}
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        resp = self._http.request(
            method, url, headers=headers, params=params,
            content=json.dumps(body) if body is not None else None,
        )
        ct = resp.headers.get("content-type", "")
        try:
            payload = resp.json() if "application/json" in ct else resp.text
        except json.JSONDecodeError:
            payload = resp.text
        if resp.status_code >= 400:
            if (
                resp.status_code == 402
                and isinstance(payload, dict)
                and payload.get("error") == "insufficient_allowance"
            ):
                raise InsufficientAllowanceError(
                    payload.get("allowance_usd", 0.0),
                    payload.get("required_usd", 0.0),
                    payload.get("approve_again_url"),
                    path,
                )
            raise SusurrationError(resp.status_code, payload, path)
        return payload  # type: ignore[return-value]

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> SusuClient: return self
    def __exit__(self, *exc: Any) -> None: self.close()
