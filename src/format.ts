/**
 * Formatting for the hidden timing block and visible idle system message.
 */

import { stripMs } from "./time.js";

const IDLE_MESSAGE_DEFAULT_THRESHOLD_SECONDS = 10;
const IDLE_MESSAGE_DEFAULT_DROP_SECONDS_AFTER_SECONDS = 3600;
const FORMAT_HOURS_AS_DAYS_DEFAULT = true;

export interface IdleConfig {
  idleMessageThresholdSeconds?: number;
  idleMessageDropSecondsAfterSeconds?: number;
  formatHoursAsDays?: boolean;
}

export interface ResolvedIdleConfig {
  thresholdMs: number;
  dropSecondsAfterSeconds: number;
  formatHoursAsDays: boolean;
}

export function resolveIdleConfig(config?: IdleConfig | null): ResolvedIdleConfig {
  if (!config) {
    return {
      thresholdMs: IDLE_MESSAGE_DEFAULT_THRESHOLD_SECONDS * 1000,
      dropSecondsAfterSeconds: IDLE_MESSAGE_DEFAULT_DROP_SECONDS_AFTER_SECONDS,
      formatHoursAsDays: FORMAT_HOURS_AS_DAYS_DEFAULT,
    };
  }

  const thresholdSeconds =
    typeof config.idleMessageThresholdSeconds === "number" &&
    Number.isFinite(config.idleMessageThresholdSeconds) &&
    config.idleMessageThresholdSeconds >= 0
      ? config.idleMessageThresholdSeconds
      : IDLE_MESSAGE_DEFAULT_THRESHOLD_SECONDS;

  const dropSecondsAfterSeconds =
    typeof config.idleMessageDropSecondsAfterSeconds === "number" &&
    Number.isFinite(config.idleMessageDropSecondsAfterSeconds) &&
    config.idleMessageDropSecondsAfterSeconds >= 0
      ? config.idleMessageDropSecondsAfterSeconds
      : IDLE_MESSAGE_DEFAULT_DROP_SECONDS_AFTER_SECONDS;

  const formatHoursAsDays =
    typeof config.formatHoursAsDays === "boolean" ? config.formatHoursAsDays : FORMAT_HOURS_AS_DAYS_DEFAULT;

  return {
    thresholdMs: thresholdSeconds * 1000,
    dropSecondsAfterSeconds,
    formatHoursAsDays,
  };
}

function appendDuration(parts: string[], name: string, valueMs: number | undefined | null): void {
  if (typeof valueMs === "number" && Number.isFinite(valueMs)) {
    parts.push(`${name}=${(valueMs / 1000).toFixed(1)}s`);
  }
}

export function formatTimingBlock(opts: {
  userMessageTime: string;
  idleSinceLastStopMs?: number | null;
  lastTurnExecMs?: number | null;
  isFirstPrompt?: boolean;
}): string {
  const lines: string[] = ["[timing]"];

  if (opts.userMessageTime) {
    const time = stripMs(opts.userMessageTime);
    if (opts.isFirstPrompt) {
      lines.push(`local_time=${time}`);
    } else {
      lines.push(time);
    }
  }

  appendDuration(lines, "idle_for", opts.idleSinceLastStopMs);
  appendDuration(lines, "last_turn_dur", opts.lastTurnExecMs);
  lines.push("[/timing]");
  return lines.join("\n");
}

export function formatIdleSystemMessage(valueMs: number | null | undefined, config?: IdleConfig | null): string | null {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs)) {
    return null;
  }

  const { thresholdMs, dropSecondsAfterSeconds, formatHoursAsDays } = resolveIdleConfig(config);

  if (valueMs <= thresholdMs) {
    return null;
  }

  const totalSeconds = Math.floor(valueMs / 1000);

  if (formatHoursAsDays && totalSeconds >= 86400) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    return `[after ${days}d ${hours}h]`;
  }

  if (formatHoursAsDays && totalSeconds >= dropSecondsAfterSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `[after ${hours}h ${minutes}m]`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }

  parts.push(`${seconds}s`);

  return `[after ${parts.join(" ")}]`;
}
