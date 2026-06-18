/**
 * Tool call and result renderers for the heartbeat control tool.
 *
 * Mirrors the pattern in ../pi-monitor/src/ui/monitor-tool-renderers.ts:
 * - renderCall shows the action being requested
 * - renderResult shows the resulting state in a compact form
 * - Both use Container to stack Text lines
 * - renderShell: "self" suppresses the default tool shell wrapper
 */
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const INDENT = " ";

export interface HeartbeatCallArgs {
  enabled?: boolean;
  minutes?: number;
}

export interface HeartbeatResultDetails {
  enabled: boolean;
  intervalMinutes: number;
  activeGoal?: string | null;
  goalActionText?: string;
}

function getGoalPreview(goal: string | null | undefined, maxLen = 32): string {
  if (!goal) return "";
  const singleLine = goal.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1) + "…";
}

/**
 * Suppressed call slot — the result line already conveys the state, and
 * showing both would duplicate the action.
 *
 * Mirrors the pattern in pi-monitor's `renderMonitorListCall`: an empty
 * `Text` produces 0 lines (verified in `@earendil-works/pi-tui` `Text.render`
 * which returns `[]` for empty/whitespace-only text). This is the official
 * pattern for "no visible content" slots per the pi-coding-agent docs.
 */
export function renderHeartbeatCall(_args: HeartbeatCallArgs, _theme: Theme): Component {
  return new Text("", 0, 0);
}

/**
 * Result shown when the heartbeat control tool completes.
 *   ♥ idle heartbeat on · 4.5m
 */
export function renderHeartbeatResult(
  details: HeartbeatResultDetails,
  _isError: boolean,
  _isPartial: boolean,
  theme: Theme,
): Component {
  const state = details.enabled ? "on" : "off";
  const goalAction = details.goalActionText?.trim() ?? "";
  const goalPreview = goalAction ? "" : getGoalPreview(details.activeGoal);
  const parts: string[] = [];

  if (goalAction) {
    parts.push(theme.fg("accent", `🎯 ${goalAction}`));
    parts.push(theme.fg(details.enabled ? "success" : "muted", ` · heartbeat ${state}`));
  } else {
    parts.push(theme.fg(details.enabled ? "success" : "muted", `♥ idle heartbeat ${state}`));
  }

  parts.push(theme.fg("muted", ` · ${details.intervalMinutes}m`));

  if (goalPreview) {
    parts.push(theme.fg("text", ` · ${goalPreview}`));
  }

  if (details.activeGoal && details.enabled) {
    parts.push(theme.fg("muted", " · keepalive paused"));
  }

  return new Text(INDENT + parts.join(""), 0, 0);
}
