/**
 * Idle goal reminder formatting.
 *
 * The goal reminder is sent as a user message after a period of inactivity.
 * The LLM sees the full formatted block; the TUI collapses it via the
 * `idle-time-goal` custom message renderer.
 */

export interface GoalMessageDetails {
  /** Compact HH:MM:SS local time. */
  time: string;
  /** Configured interval in minutes. */
  intervalMinutes: number;
  /** The goal description. */
  goal: string;
}

/**
 * Format the LLM-facing goal reminder message.
 *
 * Example output:
 *   [goal reminder] 19:46:13
 *   refactor the auth module
 *
 *   <system-reminder>Use idle_time_heartbeat_control with action=complete_goal only when the underlying task is actually finished. Idle does not mean done, and receiving this reminder does not mean the goal is complete. If work is still in progress, leave the goal active and continue working or send a status update.</system-reminder>
 */
export function formatGoalMessage(goal: string, time: string): string {
  return `[goal reminder] ${time}\n${goal}\n\n<system-reminder>Use idle_time_heartbeat_control with action=complete_goal only when the underlying task is actually finished. Idle does not mean done, and receiving this reminder does not mean the goal is complete. If work is still in progress, leave the goal active and continue working or send a status update.</system-reminder>`;
}
