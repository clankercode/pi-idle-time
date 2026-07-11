/**
 * Idle-time state event helpers.
 *
 * State changes (goal set/cleared/complete, heartbeat on/off, reset) are
 * reported to the agent via a hidden message with `customType` `idle-time-state`.
 * The message body is a small structured key=value block (one field per line)
 * so the model can read it without rendering or markdown parsing. The
 * `triggerTurn` + `deliverAs: "followUp"` delivery mirrors the heartbeat and
 * goal reminder messages so the LLM sees the change in a real assistant turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const IDLE_TIME_STATE_CUSTOM_TYPE = "idle-time-state" as const;

export type IdleTimeStateChange =
  | "heartbeat-enabled"
  | "heartbeat-disabled"
  | "goal-set"
  | "goal-cleared"
  | "goal-complete"
  | "reset-session"
  | "reset-all";

export interface IdleTimeStateFields {
  heartbeat_enabled?: boolean;
  heartbeat_interval_minutes?: number | null;
  active_goal?: string | null;
  goal_interval_minutes?: number | null;
}

export interface IdleTimeStateEvent {
  change: IdleTimeStateChange;
  fields: IdleTimeStateFields;
}

/**
 * Format a state event into the LLM-facing body. Order is stable so tests
 * can match exact lines. `null` goal values are surfaced explicitly so the
 * agent can distinguish "no goal" from "unchanged".
 */
export function formatIdleTimeStateBody(event: IdleTimeStateEvent): string {
  const lines: string[] = [];
  lines.push("[idle-time status]");
  lines.push(`change=${event.change}`);
  const entries: [keyof IdleTimeStateFields, unknown][] = [
    ["heartbeat_enabled", event.fields.heartbeat_enabled],
    ["heartbeat_interval_minutes", event.fields.heartbeat_interval_minutes],
    ["active_goal", event.fields.active_goal],
    ["goal_interval_minutes", event.fields.goal_interval_minutes],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    lines.push(`${key}=${formatFieldValue(value)}`);
  }
  return lines.join("\n");
}

function formatFieldValue(value: unknown): string {
  if (value === null) return "(none)";
  if (typeof value === "string") return value;
  return String(value);
}

export interface SendIdleTimeStateOptions {
  /**
   * When `false`, suppress the message even when a sender is provided.
   * Used while a real reminder (heartbeat keepalive or goal reminder) is
   * already queued for the same change.
   */
  send?: boolean;
}

export interface IdleTimeStateSender {
  sendMessage(message: unknown, options?: unknown): void;
}

/**
 * Send an idle-time state change event to the agent. Resolves to `true` if
 * a message was dispatched, `false` otherwise (e.g. no sender or send=false).
 */
export function sendIdleTimeStateEvent(
  sender: IdleTimeStateSender | null | undefined,
  event: IdleTimeStateEvent,
  options: SendIdleTimeStateOptions = {},
): boolean {
  if (!sender) return false;
  if (options.send === false) return false;
  const content = formatIdleTimeStateBody(event);
  try {
    sender.sendMessage(
      {
        customType: IDLE_TIME_STATE_CUSTOM_TYPE,
        content,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a renderer for the `idle-time-state` custom type so the transcript
 * collapses the change to a single line. Without a renderer pi would fall back
 * to the default content rendering.
 */
export function registerIdleTimeStateRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(IDLE_TIME_STATE_CUSTOM_TYPE, (message, { expanded }) => {
    const body = ((message as { content?: string }).content ?? "").trim();
    if (!body) return undefined;
    const firstLine = body.split(/\r?\n/, 1)[0] ?? body;
    const changeLine =
      body
        .split(/\r?\n/)
        .find((line) => line.startsWith("change=")) ?? `change=${firstLine}`;
    const change = changeLine.slice("change=".length);
    const summary = summarizeState(body);
    const header = summary ? `idle-time · ${change} · ${summary}` : `idle-time · ${change}`;
    if (!expanded) {
      return new Text(header, 0, 0);
    }
    const lines: string[] = [header];
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("change=")) continue;
      lines.push(`  ${line}`);
    }
    return new Text(lines.join("\n"), 0, 0);
  });
}

function summarizeState(body: string): string {
  const parts: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (key === "heartbeat_enabled") parts.push(`hb=${line.slice(eq + 1)}`);
    else if (key === "active_goal") parts.push(`goal=${line.slice(eq + 1)}`);
  }
  return parts.join(" ");
}
