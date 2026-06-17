/**
 * Compact message renderer for idle-time heartbeat toggle notifications.
 *
 * Triggered by the `/idle-time-heartbeat` slash command. Renders the new
 * state as a one-liner in the chat, matching the visual style of the
 * `idle_time_heartbeat_control` tool result.
 *
 *   on:  ♥ idle heartbeat on · 4.5m
 *   off: ♥ idle heartbeat off
 */
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

const ICON = "♥";
const KIND = "idle heartbeat";

export interface HeartbeatNotifyDetails {
  enabled: boolean;
  intervalMinutes: number;
  source: "command" | "tool";
}

export interface MessageLike<T> {
  content: string | unknown[];
  details?: T;
}

export const CUSTOM_TYPE = "idle-time-heartbeat-notify" as const;

export function buildCompactLine(
  message: MessageLike<HeartbeatNotifyDetails>,
  theme: Theme,
  width: number,
): string {
  const details = message.details;
  if (!details) {
    return truncateToWidth(INDENT + theme.fg("muted", `${ICON} ${KIND}`), width);
  }
  const state = details.enabled ? "on" : "off";
  const colorKey = details.enabled ? "success" : "muted";
  const interval = details.enabled && Number.isFinite(details.intervalMinutes) && details.intervalMinutes > 0
    ? ` · ${details.intervalMinutes}m`
    : "";
  return truncateToWidth(
    INDENT + theme.fg(colorKey, `${ICON} ${KIND} ${state}${interval}`),
    width,
  );
}

const INDENT = " ";

export function buildExpandedComponent(
  message: MessageLike<HeartbeatNotifyDetails>,
  theme: Theme,
): Component {
  const details = message.details;
  const state = details?.enabled ? "on" : "off";
  const colorKey = details?.enabled ? "success" : "muted";
  const interval =
    details?.enabled && Number.isFinite(details.intervalMinutes) && details.intervalMinutes > 0
      ? ` · ${details.intervalMinutes}m`
      : "";
  const source = details?.source ?? "command";
  const content = typeof message.content === "string" ? message.content : "";

  const header = ` ${theme.fg(colorKey, `${ICON} ${KIND} ${state}${interval}`)}`;
  const meta = ` ${theme.fg("muted", `via ${source}`)}`;

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Text(meta, 0, 0));
  if (content.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("toolOutput", content), 1, 0));
  }
  return container;
}

export class CompactHeartbeatNotify implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MessageLike<HeartbeatNotifyDetails>,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = this.expanded
      ? buildExpandedComponent(this.message, this.theme).render(width)
      : [buildCompactLine(this.message, this.theme, width)];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  handleInput(_data: string): void {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function registerHeartbeatNotifyRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HeartbeatNotifyDetails>(
    CUSTOM_TYPE,
    (message, { expanded }, theme) => new CompactHeartbeatNotify(message, expanded, theme),
  );
}
