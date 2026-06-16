# pi-idle-time

Pi extension that injects per-message timing context into every user prompt,
making the AI aware of wall-clock time, idle duration, and previous turn
execution time. Integrates with the pi-statusline extension.

## Architecture

This is a **pi extension** (see [pi.dev](https://pi.dev)) distributed as an npm
package. The extension hooks into pi's lifecycle events:

- `input` — on user prompt, inject timing context and optional idle system message
- `agent_end` — when the LLM finishes, record stop timestamps and turn duration
- `session_before_compact` — reset idle timer on context compaction

### Module Layout

```
src/
  index.ts          — Pi extension entry point (lifecycle hooks, statusline, commands)
  time.ts           — ISO timestamp utilities
  duration.ts       — Elapsed time formatting for statusline
  format.ts         — Timing block and idle system message formatting
  sanitize.ts       — Session ID sanitization
  config.ts         — Config loading with validation and defaults
  log.ts            — Per-session NDJSON error logger
  last-response.ts  — Flat .lastresponse file for fast statusline reads
  state.ts          — Per-session state persistence with atomic writes
```

### Statusline Integration

Uses `ctx.ui.setStatus("idle-time", text)` to display elapsed time since the
model last responded. This integrates with `@narumitw/pi-statusline` which reads
extension statuses via `getExtensionStatuses()`.

### Configuration

Stored in `${dataDir}/config.json` with these keys:

| Key | Default | Description |
|-----|---------|-------------|
| `idleMessageThresholdSeconds` | 10 | Min idle gap before visible system message |
| `idleMessageDropSecondsAfterSeconds` | 3600 | Drop trailing seconds in system message after this |
| `dropSecondsAfterSeconds` | 900 | Statusline drops seconds after this (15 min) |
| `formatHoursAsDays` | true | Format `[after 1d 4h]` instead of `[after 28h 0m]` |

### State Persistence

Per-session state is stored in `${dataDir}/sessions/<sessionId>.json`. The state
module provides atomic file writes with temp-file rename and stale tmp sweep.
Since pi extensions run in a single process, the in-process mutex serializes
concurrent operations without needing cross-process file locks.

### Commands

- `/idle-time-reset` — Clear state for current session (or all with `--all --yes`)
- `/idle-time-status` — Self-test: check data dir, state, config
- `/idle-time-config` — Show current configuration

## Development

```bash
pnpm install
pnpm test
pnpm check    # typecheck
```

## Testing

Tests use `node:test` (Node.js built-in test runner). The test suite covers:
- All utility modules (time, duration, format, sanitize, config, log, last-response, state)
- Integration tests for full prompt→stop→prompt sequences
- Concurrent state mutation safety
- Error handling and edge cases
