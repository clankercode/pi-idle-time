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
  enabled: boolean;
  minutes?: number;
}

export interface HeartbeatResultDetails {
  enabled: boolean;
  intervalMinutes: number;
}

/**
 * One-line preview shown while the heartbeat control tool is executing.
 *   idle_time_heartbeat_control on
 */
export function renderHeartbeatCall(args: HeartbeatCallArgs, theme: Theme): Component {
  const state = args.enabled ? "on" : "off";
  return new Text(
    INDENT + theme.fg("toolTitle", `idle_time_heartbeat_control ${state}`),
    0,
    0,
  );
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
  return new Text(
    INDENT +
      theme.fg(details.enabled ? "success" : "muted", `♥ idle heartbeat ${state} · ${details.intervalMinutes}m`),
    0,
    0,
  );
}
