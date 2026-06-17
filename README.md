# pi-idle-time

Pi extension that makes the AI aware of wall-clock time, idle duration, and
previous turn execution time. Includes an opt-in idle heartbeat that sends a
keepalive message to refresh the Anthropic prompt cache.

## Features

- **Per-prompt timing context** — every user message gets a hidden
  `[timing]` block with the current time, idle duration since the last
  response, and the previous turn's execution duration.
- **Statusline** — shows the elapsed time since the last response in the
  pi statusline (turn duration while the agent is active, idle timer
  when stopped). Displays `---` when the model changes mid-session.
- **Idle heartbeat** — opt-in tool that sends a keepalive user message
  after a configurable idle period. Triggers a real LLM turn, which
  refreshes the Anthropic prompt cache (default 5 min, extended 1 hour).
- **Compact TUI rendering** — the heartbeat tool result and the
  keepalive message both render as one-liners in the transcript
  (`♥ cache keepalive · 14:32:15 · 4.5m`). Press `Ctrl+E` to expand.
- **Steer-aware** — steering an active agent does not reset idle state.
- **Persistent toggle** — the heartbeat enabled state survives `/reload`
  via a global state file.

## Installation

```bash
pi install /path/to/pi-idle-time
# or from npm (when published):
# pi install npm:pi-idle-time
```

## What the model sees

On the first prompt, the extension injects a hidden timing block:

```
[timing]
local_time=2026-04-17T16:04:19+10:00
[/timing]
```

On subsequent prompts, the block includes idle and execution time:

```
[timing]
2026-04-17T16:05:19+10:00
idle_for=57.0s
last_turn_dur=88.2s
[/timing]
```

This is a `display: false` custom message — it is sent to the LLM as a
user-role message but does not appear in the TUI transcript.

When the user has been idle for more than `idleMessageThresholdSeconds`
(default 10s), a **visible** system message appears in the TUI:

```
[after 5m 2s]
```

## Commands

| Command | Description |
|---------|-------------|
| `/idle-time-reset` | Reset state for the current session |
| `/idle-time-reset --all --yes` | Wipe all sessions and logs |
| `/idle-time-status` | Show plugin status (data dir, state, config) |
| `/idle-time-config` | Show current configuration |
| `/idle-time-heartbeat on` | Enable the idle heartbeat (persists across `/reload`) |
| `/idle-time-heartbeat off` | Disable the idle heartbeat |
| `/idle-time-heartbeat` / `toggle` | Flip the current state |
| `/idle-time-heartbeat status` | Show whether the heartbeat is on or off |
| `/idle-time-heartbeat on 10` | Enable with a 10-minute override |

## Tool: `idle_time_heartbeat_control`

LLM-callable tool that enables or disables the idle heartbeat for the
current session.

```ts
idle_time_heartbeat_control(enabled: true, minutes: 4.5)
idle_time_heartbeat_control(enabled: false)
```

- `enabled` (boolean, required) — whether the heartbeat should be active
- `minutes` (number, optional) — override the interval. Must be positive.
  Falls back to `config.idleHeartbeatMinutes`, then 4.5.

The enabled state persists across `/reload` via
`~/.pi/idle-time/global.json`. Users can also toggle it directly with
the `/idle-time-heartbeat` slash command (see Commands above).

## Statusline

The extension publishes a statusline via `ctx.ui.setStatus("idle-time", text)`:

- **Agent active:** live turn duration counting up
  (`12s`, `2m15s`, `1h12m`, `1d4h`)
- **Just stopped, idle < 1s:** turn duration with idle indicator
  (`40s|💤`)
- **Idle ≥ 1s:** turn duration with idle timer
  (`40s|💤2m15s`)
- **Model changed since last stop:** `---`
- **Format options:** drops seconds after 15 min (configurable via
  `dropSecondsAfterSeconds`); format days+hours at 1 day (configurable
  via `formatHoursAsDays`)

## Idle heartbeat (cache keepalive)

The heartbeat is **opt-in and disabled by default**. When enabled, it
sends a short keepalive user message after a configurable idle period
(default 4.5 minutes). This triggers a real LLM turn, which keeps the
Anthropic prompt cache warm.

### What the model sees

```
[cache keepalive] 14:32:15 — disable via idle_time_heartbeat_control tool.
```

The `[cache keepalive]` prefix tags the message; the trailing hint
points at the tool to disable. The message is deliberately
informational — the model is not instructed to reply or take action.

### Compact TUI rendering

The keepalive is delivered via `pi.sendMessage` with
`customType: "idle-time-heartbeat"` and a custom message renderer
(see `src/heartbeat-message-renderer.ts`, modeled on the
[pi compact TUI recipe](https://pi.dev)). The keepalive collapses
to a single line in the transcript:

```
♥ cache keepalive · 14:32:15 · 4.5m
```

Press `Ctrl+E` to expand and see the full body.

### Configuration

`{time}` is replaced with the current local `HH:MM:SS`. The message
template is configurable per session.

## Configuration

Create `~/.pi/idle-time/config.json` to override defaults:

```json
{
  "idleMessageThresholdSeconds": 10,
  "idleMessageDropSecondsAfterSeconds": 3600,
  "dropSecondsAfterSeconds": 900,
  "formatHoursAsDays": true,
  "idleHeartbeatMinutes": null,
  "idleHeartbeatMessage": "[cache keepalive] {time} — disable via idle_time_heartbeat_control tool."
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `idleMessageThresholdSeconds` | 10 | Min idle gap (s) before the visible `[after Xs]` system message appears in the TUI |
| `idleMessageDropSecondsAfterSeconds` | 3600 | Drop trailing seconds in the system message after this many seconds (1 hour) |
| `dropSecondsAfterSeconds` | 900 | Statusline drops seconds after this many seconds (15 min) |
| `formatHoursAsDays` | true | Format `[after 1d 4h]` instead of `[after 28h 0m]` |
| `idleHeartbeatMinutes` | `null` | Default heartbeat interval in minutes; `null` disables it |
| `idleHeartbeatMessage` | `[cache keepalive] {time} — disable via idle_time_heartbeat_control tool.` | Keepalive message template; `{time}` is replaced with current local `HH:MM:SS` |

## Data directory

State is stored in `~/.pi/idle-time/`:

```
~/.pi/idle-time/
  config.json                  # optional user overrides
  global.json                  # global state (survives /reload)
  sessions/
    <session-id>.json          # per-session timing state
    <session-id>.lastresponse  # flat timestamp for fast reads
  logs/
    <session-id>.log           # per-session NDJSON error log
```

### `global.json` schema

```json
{
  "heartbeatEnabled": false
}
```

`heartbeatEnabled` is written by the `idle_time_heartbeat_control` tool
and read on every `session_start`. This is why the heartbeat toggle
survives `/reload` — it is not tied to any session.

### `sessions/<id>.json` schema

```json
{
  "sessionId": "019ecfd3-30e5-79d5-889a-bb22a34f01d4",
  "lastUserPromptAt": "2026-06-17T08:09:00.000+10:00",
  "lastStopAt": "2026-06-17T08:09:43.000+10:00",
  "lastAssistantMessageAt": "2026-06-17T08:09:43.000+10:00",
  "lastTurnExecMs": 42137,
  "modelAtLastStop": "claude-opus-4-5",
  "modelAtLastStopAt": "2026-06-17T08:09:43.000+10:00"
}
```

## Behavior notes

- **Steering an active agent is not a new turn.** When the user types
  while the agent is processing, the input handler does NOT reset
  idle state or inject a new timing block. Steer events are ignored
  for idle-tracking purposes.
- **Statusline idle threshold is 1 second** (not 10). The statusline
  indicator `💤` appears after just 1s of idle; the duration counter
  starts at the same point.
- **Heartbeat only fires when the agent is idle.** The timer is
  stopped on `agent_start` and `input`. When the timer fires, the
  message is sent with `deliverAs: "followUp"` so it queues properly
  if the agent is busy.
- **Timing block uses `display: false`.** It is sent to the LLM as a
  user-role message but does not appear in the TUI transcript. The
  `agent_end` event also fires a `display: false` `idle-time` message
  with the same content if needed.

## Development

```bash
pnpm install
pnpm test    # 151 tests
pnpm check   # typecheck
```

Run tests with a timeout to be safe:

```bash
timeout 30 node --import tsx --test tests/*.test.ts
```

### Module layout

```
src/
  index.ts                       — Pi extension entry point (lifecycle hooks, statusline, commands, heartbeat)
  heartbeat.ts                   — Idle heartbeat timer for cache keepalive
  heartbeat-tool-renderer.ts     — Compact renderer for the heartbeat control tool
  heartbeat-message-renderer.ts  — Compact renderer for [cache keepalive] deliverable
  heartbeat-notify-message-renderer.ts — Compact renderer for /idle-time-heartbeat toggle notifications
  global-state.ts                — Global state file (heartbeatEnabled, survives /reload)
  time.ts                        — ISO timestamp utilities
  duration.ts                    — Elapsed time formatting for statusline
  format.ts                      — Timing block and idle system message formatting
  sanitize.ts                    — Session ID sanitization
  config.ts                      — Config loading with validation and defaults
  log.ts                         — Per-session NDJSON error logger
  last-response.ts               — Flat .lastresponse file for fast statusline reads
  state.ts                       — Per-session state persistence with atomic writes
  statusline.ts                  — Statusline text formatting
```
