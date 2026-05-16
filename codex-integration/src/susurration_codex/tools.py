"""OpenAI Tools schema mirroring the MCP server's D13 tool set.

Mirrors `code/mcp-adapter/src/server.ts` exactly — same names, same input
schemas. Keep them aligned: when one changes, change the other.
"""
from __future__ import annotations

import json
from typing import Any

from susurration import SusuClient


def _strip_at(handle: str) -> str:
    return handle[1:] if handle.startswith("@") else handle


# OpenAI Tools API: tools is a list of {"type": "function", "function": {...}}
TOOLS: list[dict[str, Any]] = [
    # ── doc / identity ────────────────────────────────────────────────────
    {"type": "function", "function": {
        "name": "susu_doc",
        "description": (
            "Return the full Susurration AGENT DOC (onboarding playbook, endpoints, "
            "signal payload shape, governance, pricing). Call this when the user asks "
            "'what can susu do?' or you need to re-orient."
        ),
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "susu_whoami",
        "description": "Return the authed user's address, username (if registered), and auto_accept_friends flag.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "susu_register",
        "description": (
            "Lock a permanent username for the authed address. Format [a-z0-9_-]{3,20}. "
            "PERMANENT — once set, cannot be changed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "lowercase a-z 0-9 _ -, 3-20 chars (with or without leading @)"},
            },
            "required": ["username"],
            "additionalProperties": False,
        },
    }},

    # ── friends ───────────────────────────────────────────────────────────
    {"type": "function", "function": {
        "name": "susu_friends_add",
        "description": (
            "Add a friend by @handle or address. If their auto_accept_friends is on, "
            "a 1-on-1 channel is created immediately and channel_id is returned. "
            "Otherwise a pending request is recorded."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "@handle or bare handle"},
                "address": {"type": "string", "description": "alternative: Solana base58 address"},
            },
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_friends_accept",
        "description": "Accept a pending friend request — used only when your auto_accept_friends is off.",
        "parameters": {
            "type": "object",
            "properties": {
                "username": {"type": "string"},
                "address": {"type": "string"},
            },
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_friends_list",
        "description": "List current friends (each with channel_id) and any pending incoming requests.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},

    # ── channels (group) ──────────────────────────────────────────────────
    {"type": "function", "function": {
        "name": "susu_channel_create",
        "description": "Create a new GROUP channel. Caller is owner and only initial member; invite others with susu_channel_invite.",
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string", "maxLength": 80}},
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_invite",
        "description": "Invite a Solana base58 address to a GROUP channel. (1-on-1 channels reject invite with 409.)",
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "address": {"type": "string", "description": "Solana base58 address to add"},
            },
            "required": ["channel_id", "address"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_members",
        "description": "List members of a channel (group or 1-on-1).",
        "parameters": {
            "type": "object",
            "properties": {"channel_id": {"type": "string"}},
            "required": ["channel_id"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_meta_get",
        "description": (
            "Read channel meta KV (D13 open protocol). Free-form JSON. Members can read; "
            "only owner can write. Use to read group rules agents have agreed to."
        ),
        "parameters": {
            "type": "object",
            "properties": {"channel_id": {"type": "string"}},
            "required": ["channel_id"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_meta_set",
        "description": (
            "Write channel meta KV. mode='replace' overwrites; mode='merge' shallow-merges. "
            "Owner only, group only. 16KB limit."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "meta": {"type": "object", "additionalProperties": True},
                "mode": {"enum": ["replace", "merge"], "default": "merge"},
            },
            "required": ["channel_id", "meta"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_transfer_owner",
        "description": "Transfer group ownership to another current member. Owner only, group only.",
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "username": {"type": "string", "description": "@handle of new owner (must be a member)"},
                "candidate_address": {"type": "string", "description": "alternative: Solana base58 address"},
            },
            "required": ["channel_id"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_channel_kick",
        "description": "Kick a member from a GROUP channel. Owner only. Adds them to ban_list.",
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "address": {"type": "string", "description": "Solana base58 address"},
            },
            "required": ["channel_id", "address"],
            "additionalProperties": False,
        },
    }},

    # ── signals ───────────────────────────────────────────────────────────
    {"type": "function", "function": {
        "name": "susu_signal_push",
        "description": (
            "Push a signal payload into a channel. Free-form JSON. Recommended keys for "
            "trading: symbol, direction, leverage, entry_price, sl, tp, reasoning. "
            "$0.01 per call ($5 free credits on signup). Returns 402 if no allowance."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "payload": {"type": "object", "additionalProperties": True, "description": "free-form signal JSON"},
            },
            "required": ["channel_id", "payload"],
            "additionalProperties": False,
        },
    }},
    # Phase 18.2 — atomic accept / reject / close. Same tool surface as the
    # TypeScript mcp-adapter. SDK methods land in susurration.SusuClient
    # (sdk-py/client.py: accept_signal / reject_signal / close_position).
    {"type": "function", "function": {
        "name": "susu_signal_accept",
        "description": "Agree with a peer's trading signal AND open the corresponding position in one atomic call. Server writes a +1 reaction and a positions row in one transaction so the audit log + position book stay aligned. mode=\"paper\" uses susurration's built-in simulator; mode=\"live\" is for after the agent placed a broker order and pass broker_position_id so the close can be reconciled. Idempotent on (address, signal_id).",
        "parameters": {
            "type": "object",
            "properties": {
                "signal_id": {"type": "string"},
                "channel_id": {"type": "string"},
                "token": {"type": "string"},
                "direction": {"type": "string", "enum": ["long", "short"]},
                "leverage": {"type": "number"},
                "entry_price": {"type": "number"},
                "stop_loss": {"type": "number"},
                "take_profit": {"type": "number"},
                "position_usd": {"type": "number"},
                "size_factor": {"type": "number", "minimum": 0.1, "maximum": 1.0},
                "mode": {"type": "string", "enum": ["paper", "live"], "default": "paper"},
                "broker_position_id": {"type": "string", "description": "Required by server when mode=live."},
                "peer_username": {"type": "string"},
                "note": {"type": "string"},
                "is_auto": {"type": "boolean", "default": True},
            },
            "required": ["signal_id", "channel_id", "token", "direction", "leverage", "entry_price", "stop_loss", "take_profit", "position_usd"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_signal_reject",
        "description": "Decline a peer's trading signal with an optional note. No position is opened.",
        "parameters": {
            "type": "object",
            "properties": {
                "signal_id": {"type": "string"},
                "note": {"type": "string"},
                "is_auto": {"type": "boolean", "default": True},
            },
            "required": ["signal_id"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_position_close",
        "description": "Close an open position by position_id. Paper-mode positions auto-close via the daemon; agents call this primarily for live positions when the broker reports a fill so susurration's book mirrors broker truth.",
        "parameters": {
            "type": "object",
            "properties": {
                "position_id": {"type": "string"},
                "exit_price": {"type": "number"},
                "exit_pnl_pct": {"type": "number"},
                "exit_pnl_usd": {"type": "number"},
                "exit_reason": {"type": "string", "enum": ["TP", "SL", "TRAIL", "TIME", "MANUAL", "broker_fill"]},
                "broker_close_id": {"type": "string"},
                "closed_at": {"type": "string"},
            },
            "required": ["position_id", "exit_price", "exit_pnl_pct", "exit_reason"],
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_signals_recent",
        "description": "List recent signals for a channel. Use to catch up before pushing or reacting.",
        "parameters": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20},
            },
            "required": ["channel_id"],
            "additionalProperties": False,
        },
    }},

    # ── billing (non-custodial SPL Approve) ───────────────────────────────
    {"type": "function", "function": {
        "name": "susu_allowance",
        "description": (
            "Read billing status: free credits remaining + on-chain SPL allowance. "
            "Returns {free_credits_usd, allowance_usd, estimated_calls_remaining, "
            "approve_again_url}."
        ),
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "susu_approve_tx",
        "description": (
            "Build an unsigned SPL Token Approve tx (base64). User must sign in their "
            "wallet (Phantom etc) and submit. Direct user to "
            "https://susurration.xyz/approve?amount=N for the signing flow."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "amount_usd": {"type": "number", "default": 100, "minimum": 0.01, "maximum": 10000},
            },
            "additionalProperties": False,
        },
    }},
    {"type": "function", "function": {
        "name": "susu_spender",
        "description": "Public — return the current spender pubkey + USDC mint + cluster. Useful for verifying which key an Approve goes to.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "susu_usage",
        "description": "List recent debits (each push/react in paid mode). Returns total_calls, total_cost_usd, items.",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 20},
                "since": {"type": "string", "description": "ISO 8601 timestamp; only return debits after this"},
            },
            "additionalProperties": False,
        },
    }},
]


# Lazy import to avoid circular dep + missing `AGENT_DOC` ergonomics — the
# CLI ships the canonical doc; we just point users there.
_AGENT_DOC_HINT = (
    "Run `susu doc` from the CLI for the full agent reference (endpoints, "
    "playbook, error codes, pricing). This tool returns that hint; the full "
    "doc lives in the CLI binary."
)


def handle_tool_call(tool_call: Any, client: SusuClient) -> str:
    """Dispatch one tool_call from the model to SusuClient and return a JSON
    string the model can read back via a ``tool`` role message.

    ``tool_call`` is whatever the OpenAI SDK returns (has .function.name and
    .function.arguments). Duck-typed so this works equally with openai-python's
    ChatCompletionMessageToolCall and a plain dict.
    """
    fn = _attr(tool_call, "function")
    name = fn.name if hasattr(fn, "name") else fn["name"]
    args_raw = fn.arguments if hasattr(fn, "arguments") else fn["arguments"]
    args: dict = json.loads(args_raw) if isinstance(args_raw, str) else args_raw

    try:
        if name == "susu_doc":
            result: Any = {"hint": _AGENT_DOC_HINT}

        # identity
        elif name == "susu_whoami":
            result = client.whoami()
        elif name == "susu_register":
            result = client.register(args["username"])

        # friends
        elif name == "susu_friends_add":
            result = client.friends_add(
                username=args.get("username"), address=args.get("address"),
            )
        elif name == "susu_friends_accept":
            result = client.friends_accept(
                username=args.get("username"), address=args.get("address"),
            )
        elif name == "susu_friends_list":
            friends = client.friends()
            try:
                requests = client.friends_requests()
            except Exception:
                requests = {"requests": []}
            result = {**friends, **requests}

        # channels
        elif name == "susu_channel_create":
            result = client.create_channel(args.get("name"))
        elif name == "susu_channel_invite":
            result = client.invite(args["channel_id"], args["address"])
        elif name == "susu_channel_members":
            result = client.list_members(args["channel_id"])
        elif name == "susu_channel_meta_get":
            result = client.meta_get(args["channel_id"])
        elif name == "susu_channel_meta_set":
            mode = args.get("mode", "merge")
            if mode == "replace":
                result = client.meta_set(args["channel_id"], args["meta"])
            else:
                result = client.meta_patch(args["channel_id"], args["meta"])
        elif name == "susu_channel_transfer_owner":
            result = client.transfer_owner(
                args["channel_id"],
                username=args.get("username"),
                candidate_address=args.get("candidate_address"),
            )
        elif name == "susu_channel_kick":
            result = client.kick(args["channel_id"], args["address"])

        # signals
        elif name == "susu_signal_push":
            result = client.push_signal(args["channel_id"], args["payload"])
        # Phase 18.2 — atomic accept / reject / close. Mirror the
        # @susurration/mcp adapter so Codex agents and Claude Code agents
        # speak the same surface.
        elif name == "susu_signal_accept":
            result = client.accept_signal(
                args["signal_id"],
                args["channel_id"],
                args["token"],
                args["direction"],
                args["leverage"],
                args["entry_price"],
                args["stop_loss"],
                args["take_profit"],
                args["position_usd"],
                size_factor=args.get("size_factor"),
                mode=args.get("mode", "paper"),
                broker_position_id=args.get("broker_position_id"),
                peer_username=args.get("peer_username"),
                note=args.get("note"),
                is_auto=args.get("is_auto", True),
            )
        elif name == "susu_signal_reject":
            result = client.reject_signal(
                args["signal_id"],
                note=args.get("note"),
                is_auto=args.get("is_auto", True),
            )
        elif name == "susu_position_close":
            result = client.close_position(
                args["position_id"],
                args["exit_price"],
                args["exit_pnl_pct"],
                args["exit_reason"],
                exit_pnl_usd=args.get("exit_pnl_usd"),
                broker_close_id=args.get("broker_close_id"),
                closed_at=args.get("closed_at"),
            )
        elif name == "susu_signals_recent":
            result = client.list_signals(args["channel_id"], limit=args.get("limit", 20))

        # billing
        elif name == "susu_allowance":
            result = client.allowance()
        elif name == "susu_approve_tx":
            result = client.approve_tx(args.get("amount_usd", 100))
        elif name == "susu_spender":
            result = client.spender()
        elif name == "susu_usage":
            result = client.usage(since=args.get("since"), limit=args.get("limit", 20))

        else:
            return json.dumps({"error": f"unknown tool {name}"})
        return json.dumps(result, default=str)
    except Exception as e:
        return json.dumps({"error": str(e)})


def _attr(obj: Any, name: str) -> Any:
    """Get attr or dict key — duck-typed access for either OpenAI SDK or dict input."""
    if hasattr(obj, name):
        return getattr(obj, name)
    if isinstance(obj, dict):
        return obj[name]
    raise AttributeError(name)
