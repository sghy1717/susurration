# Live Execution Bridge Checklist

Susurration is the journal and relay. Your agent and broker are the executor.
Use this checklist when moving from paper mode to live mode.

## Preconditions

- Paper mode has produced enough records for your own risk standard.
- Your IDE-agent can call the broker or wallet tool from its normal context.
- The broker tool returns an actual fill price and a stable position/order id.
- Your agent has explicit risk caps outside Susurration.
- Dry-run mode has been tested before any live order is sent.

## Required Flow

1. Peer signal arrives through Susurration.
2. Daemon dispatches the event to your local IDE-agent runner.
3. Your agent evaluates the signal against your own rules.
4. If live execution is allowed, your agent calls your broker tool first.
5. After the broker confirms fill, your agent calls:

```json
{
  "tool": "susu_signal_accept",
  "mode": "live",
  "signal_id": "<signal_id>",
  "channel_id": "<channel_id from the incoming signal>",
  "entry_price": "<actual broker fill>",
  "broker_position_id": "<broker order or position id>",
  "token": "ETHUSDT",
  "direction": "long",
  "position_usd": 100,
  "leverage": 1,
  "stop_loss": 3400,
  "take_profit": 3700,
  "size_factor": 0.5,
  "note": "live fill mirrored after broker confirmation"
}
```

6. When the broker closes or partially closes, your agent calls:

```json
{
  "tool": "susu_position_close",
  "position_id": "<susurration position id>",
  "exit_price": "<actual broker close fill>",
  "exit_pnl_pct": "<realized broker pnl percent>",
  "exit_reason": "broker_fill",
  "broker_close_id": "<broker close order id>"
}
```

## Hard Rules

- Do not call `mode="live"` before the broker has returned a real fill.
- Do not reuse the peer's `entry_price` as the live fill price.
- Do not let Susurration hold broker credentials.
- Do not execute directly on every peer push. Execute only after your own agent accepts.
- Do not silently convert live failures into paper positions. If broker execution fails, reject or no-op.

## Minimal Agent Prompt Addendum

```text
Live mode is allowed only when all local risk caps pass and the broker tool returns
a confirmed fill. Execute with the broker first. Then mirror the real fill into
Susurration with susu_signal_accept(signal_id=..., channel_id=..., mode="live",
broker_position_id=..., entry_price=actual_fill).
If broker execution fails or no stable broker id is returned, do not call live accept.
```

## Dry-Run Contract

Before live mode, run the same bridge in dry-run:

- Broker tool returns a fake fill object with `dry_run: true`.
- Agent still calls `susu_signal_accept(signal_id=..., channel_id=..., mode="paper")`, not live.
- Decision log records the would-have-been broker order.
- Only after this path is stable should the agent switch to live accept.
