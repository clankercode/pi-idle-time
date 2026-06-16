/**
 * Statusline formatting logic — pure function, no side effects.
 *
 * Composes the display string shown in the pi footer/extension status line.
 */

import { formatElapsed } from "./duration.js";
import { diffMs, getNowIso } from "./time.js";

export interface StatuslineState {
  isAgentActive: boolean;
  turnStartAt: string | null;
  turnDurationFrozen: string | null;
  lastStopAt: string | null;
  lastAssistantMessageAt: string | null;
  currentModelId: string | null;
  modelAtLastStop: string | null;
  modelAtLastStopAt: string | null;
}

export function formatStatusline(
  state: StatuslineState,
  opts: { dropSecondsAfterSeconds: number },
  now?: string,
): string | undefined {
  const nowIso = now ?? getNowIso();

  // Format turn duration: live if active, frozen if just finished
  let turnText: string | null = null;
  if (state.isAgentActive && state.turnStartAt) {
    const elapsed = diffMs(nowIso, state.turnStartAt);
    turnText = formatElapsed(elapsed, opts);
  } else if (state.turnDurationFrozen) {
    turnText = state.turnDurationFrozen;
  }

  // Model change detection
  const effectiveLastResponseAt = state.lastAssistantMessageAt || state.lastStopAt;
  if (
    state.currentModelId &&
    state.modelAtLastStopAt &&
    effectiveLastResponseAt === state.modelAtLastStopAt &&
    state.modelAtLastStop &&
    state.currentModelId !== state.modelAtLastStop
  ) {
    const prefix = turnText ? `${turnText} | ` : "";
    return `${prefix}---`;
  }

  // Format idle duration
  const lastResponseAt = state.lastAssistantMessageAt || state.lastStopAt;
  let idleText: string | null = null;
  if (!state.isAgentActive && lastResponseAt) {
    const idleMs = diffMs(nowIso, lastResponseAt);
    const idleSeconds = typeof idleMs === "number" ? Math.floor(idleMs / 1000) : null;
    if (idleSeconds !== null && idleSeconds >= 1) {
      idleText = formatElapsed(idleMs, opts);
    } else if (idleSeconds !== null && idleSeconds >= 0) {
      idleText = ""; // idle but < 1s, show indicator without timer
    }
  }

  // Compose final statusline
  const parts: string[] = [];
  if (turnText) parts.push(turnText);

  if (state.isAgentActive) {
    return parts.join("") || undefined;
  }

  if (idleText !== null) {
    parts.push(idleText ? `💤 ${idleText}` : "💤");
    return parts.join(" | ");
  }

  if (parts.length > 0) {
    return parts.join("");
  }

  return undefined;
}
