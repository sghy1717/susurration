#!/usr/bin/env python3
"""
Live bridge hook template.

Wire this from ~/.susu/agent-config.json:

  "on_decision": "python3 ~/my_live_bridge.py"

The daemon sends JSON on stdin after every decision. This template does not
place trades. Replace the broker_* stubs with your own broker MCP / API calls.
Never print API keys or broker secrets.
"""

import json
import sys
from typing import Any


MIN_SIZE_FACTOR = 0.5
LIVE_ENABLED = False  # flip only after dry-run review


def broker_open_order(signal: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
    """Replace with the user's broker call.

    Must return:
      { "ok": True, "fill_price": 3500.0, "broker_position_id": "..." }
    """
    return {"ok": False, "error": "broker_open_order not implemented"}


def main() -> int:
    event = json.load(sys.stdin)
    decision = event.get("decision") or {}
    trigger = event.get("trigger") or {}
    payload = trigger.get("payload") or {}
    decision_payload = decision.get("payload") or {}

    if decision.get("kind") != "react":
        return 0
    if decision_payload.get("value") != "+1":
        return 0
    if float(decision_payload.get("size_factor") or 0) < MIN_SIZE_FACTOR:
        return 0
    if not LIVE_ENABLED:
        print(json.dumps({"ok": True, "mode": "dry_run", "reason": "LIVE_ENABLED=false"}))
        return 0

    fill = broker_open_order(payload, decision_payload)
    if not fill.get("ok"):
        print(json.dumps({"ok": False, "stage": "broker_open", "error": fill.get("error", "unknown")}))
        return 0

    # Do not call susu_signal_accept here unless this hook owns the Susurration
    # API token and can safely mirror the confirmed broker fill. Most users
    # should let their IDE-agent do that with the MCP tool, because it already
    # has the Susurration context and permission boundary.
    print(json.dumps({
        "ok": True,
        "mode": "live_fill_ready",
        "fill_price": fill["fill_price"],
        "broker_position_id": fill["broker_position_id"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
