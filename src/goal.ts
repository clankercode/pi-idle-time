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
 *   <system-reminder>Use idle_time_heartbeat_control with completeGoal=true to mark the goal complete.</system-reminder>
 */
export function formatGoalMessage(goal: string, time: string): string {
  return `[goal reminder] ${time}\n${goal}\n\n<system-reminder>Use idle_time_heartbeat_control with completeGoal=true to mark the goal complete.</system-reminder>`;
}
