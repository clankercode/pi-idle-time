/**
 * Compact message renderer for idle goal reminder messages.
 *
 * Mirrors the heartbeat renderer pattern: collapsed to a single themed line,
 * expanded to show the full reminder body.
 */
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { GoalMessageDetails } from "./goal.js";

export type { GoalMessageDetails };

const ICON = "🎯";
const KIND = "idle goal";

export const CUSTOM_TYPE = "idle-time-goal" as const;

export interface MessageLike<T> {
  content: string | unknown[];
  details?: T;
}

function getTime(details: GoalMessageDetails | undefined): string {
  return details?.time ?? "";
}

function getInterval(details: GoalMessageDetails | undefined): string {
  if (details === undefined || details.intervalMinutes === undefined) return "";
  return `${details.intervalMinutes}m`;
}

function getGoalPreview(details: GoalMessageDetails | undefined, maxLen = 40): string {
  if (!details?.goal) return "";
  const goal = details.goal.replace(/\s+/g, " ").trim();
  if (goal.length <= maxLen) return goal;
  return goal.slice(0, maxLen - 1) + "…";
}

/**
 * Build a single-line preview for collapsed display.
 *   🎯 idle goal · refactor the auth module · 14:32:15 · 4.5m
 */
export function buildCompactLine(
  message: MessageLike<GoalMessageDetails>,
  theme: Theme,
  width: number,
): string {
  const details = message.details;
  const time = getTime(details);
  const interval = getInterval(details);
  const preview = getGoalPreview(details);

  const parts: string[] = [];
  parts.push(" " + theme.fg("accent", `${ICON} ${KIND}`));
  if (preview) {
    parts.push(theme.fg("text", ` · ${preview}`));
  }
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
 */
export function buildExpandedComponent(
  message: MessageLike<GoalMessageDetails>,
  theme: Theme,
): Component {
  const details = message.details;
  const time = getTime(details);
  const interval = getInterval(details);
  const preview = getGoalPreview(details, Number.MAX_SAFE_INTEGER);
  const content = typeof message.content === "string" ? message.content : "";

  const header = ` ${theme.fg("accent", `${ICON} ${KIND}`)}` +
    (preview ? theme.fg("text", ` · ${preview}`) : "") +
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

export class CompactGoalMessage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MessageLike<GoalMessageDetails>,
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

export function registerGoalMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<GoalMessageDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
    return new CompactGoalMessage(message, expanded, theme);
  });
}
