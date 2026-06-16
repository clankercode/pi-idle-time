/**
 * Compact message renderer for the [cache keepalive] heartbeat messages.
 *
 * Mirrors the pattern in `~/.llm-general/ai-coding/pi/compact-tui-renderer-recipe.md`:
 * - Collapsed: a single themed line with the icon, kind label, and time.
 * - Expanded: a header with metadata + the full message body.
 *
 * The renderer is registered against the `idle-time-heartbeat` customType, which
 * is what the extension uses when calling `pi.sendMessage()` to deliver the
 * keepalive. This makes the message collapse to one line in the chat (instead
 * of the default raw multi-line user-role display).
 */
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

const ICON = "♥";
const KIND = "cache keepalive";

export interface HeartbeatMessageDetails {
  /** Compact HH:MM:SS local time. */
  time: string;
  /** Configured interval in minutes. */
  intervalMinutes: number;
}

export interface MessageLike<T> {
  content: string | unknown[];
  details?: T;
}

export const CUSTOM_TYPE = "idle-time-heartbeat" as const;

function getTime(details: HeartbeatMessageDetails | undefined): string {
  return details?.time ?? "";
}

function getInterval(details: HeartbeatMessageDetails | undefined): string {
  if (details === undefined || details.intervalMinutes === undefined) return "";
  return `${details.intervalMinutes}m`;
}

/**
 * Build a single-line preview for collapsed display.
 *   ♥ cache keepalive · 14:32:15 · 4.5m
 */
export function buildCompactLine(
  message: MessageLike<HeartbeatMessageDetails>,
  theme: Theme,
  width: number,
): string {
  const details = message.details;
  const time = getTime(details);
  const interval = getInterval(details);

  const parts: string[] = [];
  parts.push(" " + theme.fg("accent", `${ICON} ${KIND}`));
  if (time) {
    parts.push(theme.fg("text", ` · ${time}`));
  }
  if (interval) {
    parts.push(theme.fg("muted", ` · ${interval}`));
  }

  return truncateToWidth(parts.join(""), width);
}

/**
 * Build a multi-line component for the expanded view.
 *   ♥ cache keepalive · 14:32:15 · 4.5m
 *      [cache keepalive] 14:32:15 — disable via idle_time_heartbeat_control tool.
 */
export function buildExpandedComponent(
  message: MessageLike<HeartbeatMessageDetails>,
  theme: Theme,
): Component {
  const details = message.details;
  const time = getTime(details);
  const interval = getInterval(details);
  const content = typeof message.content === "string" ? message.content : "";

  const header = ` ${theme.fg("accent", `${ICON} ${KIND}`)}` +
    (time ? theme.fg("text", ` · ${time}`) : "") +
    (interval ? theme.fg("muted", ` · ${interval}`) : "");

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  if (content.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("toolOutput", content), 1, 0));
  }
  return container;
}

export class CompactHeartbeatMessage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MessageLike<HeartbeatMessageDetails>,
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

export function registerHeartbeatMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HeartbeatMessageDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
    return new CompactHeartbeatMessage(message, expanded, theme);
  });
}
