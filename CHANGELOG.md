# Changelog

## 0.4.3 — 2026-07-11

### Fixed

- Manually changing idle-goal or heartbeat state was previously only shown to
  the user via the TUI: the agent saw no transcript/system event. Now every
  manual change (slash command, tool, or reset) emits an agent-visible state
  event with `customType: "idle-time-state"`, delivered with the same
  `triggerTurn + deliverAs: "followUp"` envelope used by the heartbeat and goal
  reminders. The renderer collapses the event to a one-liner in the transcript
  and expands to the full key=value body on `Ctrl+E`.
- `idle_time_heartbeat_control({})` previously returned `No idle-time changes
  applied.` and exposed no state. It is now a read-only query returning the
  active goal, heartbeat enabled state, and effective interval for each.

### Tests

- New `tests/idle-time-state.test.ts` covers formatting, dispatch (sender
  errors, suppressed sends, customType and delivery options), and the
  collapsed/expanded renderer shapes.
- `tests/index.test.ts` adds regression coverage for agent-visible events on
  `/idle-time-heartbeat` toggles, `/idle-goal set`, `/idle-time-reset`, and
  the read-only tool query.

## 0.4.2

README updates, docs for compaction/heartbeat/corrupt-quarantine.
