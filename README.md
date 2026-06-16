# pi-idle-time

Pi extension that injects per-message timing context into every user prompt,
making the AI aware of wall-clock time, idle duration, and previous turn
execution time.

## Installation

```bash
pi install /path/to/pi-idle-time
# or from npm (when published):
# pi install npm:pi-idle-time
```

## What it does

On every prompt, the extension injects a hidden timing block into the system
prompt:

```
[timing]
local_time=2026-04-17T16:04:19+10:00
[/timing]
```

On subsequent prompts, it includes idle time and turn duration:

```
[timing]
2026-04-17T16:05:19+10:00
idle_for=57.0s
last_turn_dur=88.2s
[/timing]
```

When the user has been idle for more than the configured threshold (default
10 seconds), a **visible** system message appears in the TUI:

```
[after 5m 2s]
```

## Idle heartbeat (cache keepalive)

When enabled, `pi-idle-time` can send a short keepalive user message after a
period of inactivity. This triggers a real assistant turn, which keeps the
Anthropic prompt cache warm (default cache TTL is 5 minutes; extended TTL is 1
hour).

**The heartbeat is opt-in and disabled by default.** It consumes tokens and
produces a visible assistant response each time it fires.

Enable it by asking the agent to call:

```
idle_time_heartbeat_control(enabled: true, minutes: 4.5)
```

Disable it with:

```
idle_time_heartbeat_control(enabled: false)
```

The enabled state is persisted per session. The agent can toggle it; users can
also set a default interval in `config.json`.

## Statusline integration

Displays elapsed time since the model last responded in the statusline footer.
Integrates with `@narumitw/pi-statusline` via `ctx.ui.setStatus()`.

Shows `---` when the model changes since the last response (e.g., switching
from sonnet to opus mid-session).

## Commands

| Command | Description |
|---------|-------------|
| `/idle-time-reset` | Reset state for current session |
| `/idle-time-reset --all --yes` | Wipe all sessions and logs |
| `/idle-time-status` | Show plugin status |
| `/idle-time-config` | Show current configuration |

## Configuration

Create `~/.pi/idle-time/config.json` to override defaults:

```json
{
  "idleMessageThresholdSeconds": 10,
  "idleMessageDropSecondsAfterSeconds": 3600,
  "dropSecondsAfterSeconds": 900,
  "formatHoursAsDays": true,
  "idleHeartbeatMinutes": null,
  "idleHeartbeatMessage": "cache keepalive — current local time is {time}"
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `idleMessageThresholdSeconds` | 10 | Min idle gap before visible system message |
| `idleMessageDropSecondsAfterSeconds` | 3600 | Drop trailing seconds in system message after this |
| `dropSecondsAfterSeconds` | 900 | Statusline drops seconds after this (15 min) |
| `formatHoursAsDays` | true | Format `[after 1d 4h]` instead of `[after 28h 0m]` |
| `idleHeartbeatMinutes` | `null` | Default heartbeat interval in minutes; `null` disables it |
| `idleHeartbeatMessage` | `cache keepalive — current local time is {time}` | Message template; `{time}` is replaced with current time |

## Data directory

State is stored in `~/.pi/idle-time/`:

```
~/.pi/idle-time/
  config.json              # optional overrides
  sessions/
    <session-id>.json      # per-session timing state
    <session-id>.lastresponse  # flat timestamp for fast reads
  logs/
    <session-id>.log       # per-session NDJSON error log
```

## Development

```bash
pnpm install
pnpm test    # 77 tests
pnpm check   # typecheck
```
