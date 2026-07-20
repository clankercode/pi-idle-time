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
- **Idle goal reminders** — `/idle-goal <description>` sets a goal the
  model is reminded of after the heartbeat interval. Goal reminders take
  precedence over the keepalive while a goal is active.

## Installation

```bash
pi install npm:pi-idle-time
# or from a local checkout:
# pi install /path/to/pi-idle-time
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
[sent after 5m 2s]
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
| `/idle-goal <description>` | Set an idle goal reminder |
| `/idle-goal` / `/idle-goal --status` | Show the active goal |
| `/idle-goal --complete` | Mark the active goal complete |

When toggled, the command:

- Updates in-memory `heartbeatEnabled`
- Persists to global state (survives `/reload`)
- Shows a UI-only notification via `ctx.ui.notify` (NOT sent to LLM)

The notification is a plain-text toast:

  on:  `♥ idle heartbeat on · 4.5m`
  off: `♥ idle heartbeat off`

The notification is plain text rather than the custom compact one-liner
the keepalive uses, because the runtime's `display: true` path also
adds the message to LLM context. There is no built-in way to show a
custom message in chat without it being sent to the model. Toggling is
a pure UI state change, so we use `ctx.ui.notify` to keep it out of
the LLM's context.

## Tool: `idle_time_heartbeat_control`

LLM-callable tool that controls the idle heartbeat and idle goal for
the current session via an explicit `action`:

```ts
idle_time_heartbeat_control({ action: "enable", minutes: 4.5 })
idle_time_heartbeat_control({ action: "disable" })
idle_time_heartbeat_control({ action: "set_goal", goal: "draft release notes for v0.4.1" })
idle_time_heartbeat_control({ action: "complete_goal" })
idle_time_heartbeat_control({ action: "clear_goal" })
idle_time_heartbeat_control({}) // or action: "status"
```

- `action` (string, optional) — one of:
  - `status` (default when omitted) — read-only query of current state
  - `enable` / `disable` — toggle the generic cache-keepalive heartbeat
  - `set_goal` — set the idle goal (requires non-empty `goal`)
  - `complete_goal` — mark the active goal complete
  - `clear_goal` — drop the goal without marking it complete
- `minutes` (number, optional) — interval override (positive). Applies
  with `enable` (heartbeat interval) or `set_goal` (goal reminder
  interval). Falls back to `config.idleHeartbeatMinutes`, then 4.5.
  Remembered per session per mode.
- `goal` (string, optional) — required for `set_goal`. Setting a goal
  does not enable the generic heartbeat.

Goal reminders run independently of keepalive enable and take
precedence while a goal is active. Completing a goal resumes the
generic heartbeat only if it was independently enabled.

See [Querying current state](#querying-current-state) for the status
response shape.

The generic heartbeat enabled state persists across `/reload` via
`~/.pi/idle-time/global.json`. The active goal persists per session in
`~/.pi/idle-time/sessions/<id>.json`. Users can also toggle directly
with the `/idle-time-heartbeat` and `/idle-goal` slash commands (see
Commands above).

## Idle goal reminders

`/idle-goal <description>` sets a per-session goal. After the configured
interval of inactivity the extension sends the LLM:

```
[goal reminder] HH:MM:SS
<description>

<system-reminder>Use idle_time_heartbeat_control with action=complete_goal only when the underlying task is actually finished. Idle does not mean done, and receiving this reminder does not mean the goal is complete. If work is still in progress, leave the goal active and continue working or send a status update.</system-reminder>
```

The user sees a compact TUI render
(`🎯 idle goal · <preview> · <time> · <interval>`). Goal reminders take
precedence over the keepalive heartbeat while a goal is active, and
fire regardless of the generic heartbeat enabled state.

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

State is stored in `~/.pi/idle-time/`. Corrupt state files (malformed
JSON) are automatically renamed to `<filename>.corrupt-<timestamp>` and
the extension falls back to defaults — no data is silently lost.

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

## Agent-visible state events

Every manual change to idle-goal or heartbeat state emits a structured
event to the agent, delivered as a hidden user-role message with
`customType: "idle-time-state"` and `display: true`, with the same
`triggerTurn` + `deliverAs: "followUp"` delivery used for heartbeat
keepalives and goal reminders. The body is a small key=value block:

```
[idle-time status]
change=goal-set
heartbeat_enabled=true
heartbeat_interval_minutes=4.5
active_goal=refactor the auth module
goal_interval_minutes=4.5
```

`change` is one of: `heartbeat-enabled`, `heartbeat-disabled`,
`goal-set`, `goal-cleared`, `goal-complete`, `reset-session`,
`reset-all`. The renderer collapses the block to a one-liner in the
transcript:

```
idle-time · goal-set · hb=true · goal=refactor the auth module
```

So the agent always knows when the user manually toggles state, even
outside a tool call.

## Querying current state

Calling `idle_time_heartbeat_control({})` with no parameters is a
read-only status query. It returns the same structured block:

```
[idle-time status]
heartbeat_enabled=true
heartbeat_interval_minutes=4.5
active_goal=refactor the auth module
goal_interval_minutes=4.5
```

The query is non-mutating: it does not change any timer, persist any
state, or send a hidden message. Use it any time the agent needs to
verify the current idle-time configuration.

## Behavior notes

- **Steering an active agent is not a new turn.** When the user types
  while the agent is processing, the input handler does NOT reset
  idle state or inject a new timing block. Steer events are ignored
  for idle-tracking purposes.
- **Statusline idle threshold is 1 second** (not 10). The statusline
  indicator `💤` appears after just 1s of idle; the duration counter
  starts at the same point.
- **Heartbeat and goal reminders only fire when the agent is idle.**
  The agent is marked busy for the whole turn from `agent_start`
  through `agent_end` (including follow-up turns with no user input).
  Timers are stopped while busy and are not re-armed by mid-turn
  `set_goal` / enable calls; fire paths re-check busy before delivery.
  When a reminder does fire, it is sent with `deliverAs: "followUp"`.
- **Timing block uses `display: false`.** It is sent to the LLM as a
  user-role message but does not appear in the TUI transcript. The
  `agent_end` event also fires a `display: false` `idle-time` message
  with the same content if needed.
- **Compaction resumes timers.** When context compaction fires
  (`session_before_compact`), the extension updates `lastStopAt` and
  `lastAssistantMessageAt` to now, clears model tracking, and restarts
  both the goal timer and the heartbeat timer. If a goal or heartbeat
  was active before compaction, it resumes with the compaction timestamp
  as the new idle baseline.
- **Per-session interval overrides persist.** When the LLM sets a goal
  with a `minutes` parameter, that interval is saved in the session state
  file and restored on the next `session_start`.
- **Config is cached per session.** The config module caches the loaded
  `config.json` per `dataDir`. Edits to `config.json` take effect on the
  next session, not immediately in the current one.

## Development

```bash
pnpm install
pnpm test    # 175 tests
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
  goal.ts                        — Idle goal reminder message formatting
  goal-message-renderer.ts       — Compact renderer for [goal reminder] deliverable
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
