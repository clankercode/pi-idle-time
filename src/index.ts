/**
 * pi-idle-time — Pi extension that injects per-message timing context.
 *
 * Maps the original Claude Code hooks to Pi lifecycle events:
 *   UserPromptSubmit → input + before_agent_start
 *   Stop             → agent_end
 *   PreCompact       → session_before_compact
 *
 * Statusline integration via ctx.ui.setStatus("idle-time", text).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatTimingBlock, formatIdleSystemMessage, type IdleConfig } from "./format.js";
import { formatElapsed } from "./duration.js";
import { loadSessionState, updateSessionState, type SessionState } from "./state.js";
import { loadGlobalState, saveGlobalState } from "./global-state.js";
import { getNowIso, diffMs } from "./time.js";
import { loadConfig, type Config } from "./config.js";
import { logError } from "./log.js";
import { writeLastResponse } from "./last-response.js";
import { formatStatusline, type StatuslineState } from "./statusline.js";
import {
  renderHeartbeatCall,
  renderHeartbeatResult,
  type HeartbeatCallArgs,
  type HeartbeatResultDetails,
} from "./heartbeat-tool-renderer.js";
import {
  registerHeartbeatMessageRenderer,
  CUSTOM_TYPE as HEARTBEAT_CUSTOM_TYPE,
  type HeartbeatMessageDetails,
} from "./heartbeat-message-renderer.js";
import { registerGoalMessageRenderer, CUSTOM_TYPE as GOAL_CUSTOM_TYPE } from "./goal-message-renderer.js";
import { formatGoalMessage, type GoalMessageDetails } from "./goal.js";
import { HeartbeatTimer } from "./heartbeat.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const STATUSLINE_KEY = "⏳";
const STATUSLINE_REFRESH_MS = 1000;

function resolveDataDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".pi", "idle-time");
}

export default function idleTimeExtension(pi: ExtensionAPI): void {
  // Register the compact message renderers for heartbeat and goal messages
  registerHeartbeatMessageRenderer(pi);
  registerGoalMessageRenderer(pi);

  const dataDir = resolveDataDir();
  let sessionId: string | null = null;
  let setStatusRef: ((key: string, text: string | undefined) => void) | null = null;
  let statuslineTimer: ReturnType<typeof setInterval> | null = null;
  let currentModelId: string | null = null;

  // In-memory state for the current session
  let lastUserPromptAt: string | null = null;
  let lastStopAt: string | null = null;
  let lastAssistantMessageAt: string | null = null;
  let lastTurnExecMs: number | null = null;
  let modelAtLastStop: string | null = null;
  let modelAtLastStopAt: string | null = null;
  let turnStartAt: string | null = null;
  let turnDurationFrozen: string | null = null;
  let heartbeatEnabled: boolean = false;
  let heartbeatIntervalMinutes: number | null = null;
  let activeGoal: string | null = null;
  let goalCreatedAt: string | null = null;
  let goalIntervalMinutes: number | null = null;

  // Timings captured during input, consumed by before_agent_start
  let pendingTimingBlock: string | null = null;
  let pendingIdleMessage: string | null = null;
  let isAgentActive = false;

  let heartbeatTimer: HeartbeatTimer | null = null;
  let goalTimer: HeartbeatTimer | null = null;

  function getDataDir(): string {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      // ignore
    }
    return dataDir;
  }

  function getConfig(): Config {
    return loadConfig({ dataDir: getDataDir() });
  }

  function normalizeIntervalMinutes(intervalMinutes?: number | null): number | null {
    if (!Number.isFinite(intervalMinutes) || intervalMinutes == null || intervalMinutes <= 0) {
      return null;
    }
    return intervalMinutes;
  }

  function resolveIntervalMinutes(
    intervalOverride?: number | null,
    storedInterval?: number | null,
  ): number {
    return normalizeIntervalMinutes(intervalOverride)
      ?? normalizeIntervalMinutes(storedInterval)
      ?? normalizeIntervalMinutes(getConfig().idleHeartbeatMinutes)
      ?? 4.5;
  }

  function getLastResponseAt(): string | null {
    return lastAssistantMessageAt ?? lastStopAt;
  }

  function getCurrentHeartbeatIntervalMinutes(): number {
    return resolveIntervalMinutes(undefined, heartbeatIntervalMinutes);
  }

  function getCurrentGoalIntervalMinutes(): number {
    return resolveIntervalMinutes(undefined, goalIntervalMinutes);
  }

  function maybeStartHeartbeat(intervalOverride?: number): void {
    if (!sessionId) return;
    if (isAgentActive) {
      heartbeatTimer?.stop();
      return;
    }
    const config = getConfig();
    // Goal reminders take precedence over the keepalive heartbeat.
    if (activeGoal) {
      heartbeatTimer?.stop();
      return;
    }
    const intervalMinutes = resolveIntervalMinutes(intervalOverride, heartbeatIntervalMinutes);
    if (!heartbeatEnabled) {
      heartbeatTimer?.stop();
      return;
    }
    const lastResponseAt = getLastResponseAt();
    if (!lastResponseAt) {
      heartbeatTimer?.stop();
      return;
    }

    if (!heartbeatTimer || heartbeatTimer.interval !== intervalMinutes) {
      heartbeatTimer?.stop();
      heartbeatTimer = new HeartbeatTimer({
        intervalMinutes,
        messageTemplate: config.idleHeartbeatMessage,
        onFire: () => {
          try {
            const message = heartbeatTimer?.formatMessage() ?? config.idleHeartbeatMessage;
            const time = heartbeatTimer?.formatCompactTime() ?? "";
            const details: HeartbeatMessageDetails = { time, intervalMinutes };
            pi.sendMessage(
              {
                customType: HEARTBEAT_CUSTOM_TYPE,
                content: message,
                display: true,
                details,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch (error) {
            logError({ dataDir, sessionId, hook: "heartbeat", error });
          }
        },
      });
    } else {
      heartbeatTimer.configure({ messageTemplate: config.idleHeartbeatMessage });
    }
    heartbeatTimer.start(lastResponseAt);
  }

  function stopHeartbeat(): void {
    heartbeatTimer?.stop();
  }

  function sendGoalReminder(intervalMinutes: number): void {
    if (!sessionId || !activeGoal) return;
    try {
      const time = goalTimer?.formatCompactTime() ?? "";
      const message = formatGoalMessage(activeGoal, time);
      const details: GoalMessageDetails = { time, intervalMinutes, goal: activeGoal };
      pi.sendMessage(
        {
          customType: GOAL_CUSTOM_TYPE,
          content: message,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch (error) {
      logError({ dataDir, sessionId, hook: "goalReminder", error });
    }
  }

  function maybeStartGoalTimer(intervalOverride?: number): void {
    if (!sessionId || !activeGoal) {
      goalTimer?.stop();
      return;
    }
    if (isAgentActive) {
      goalTimer?.stop();
      return;
    }
    const intervalMinutes = resolveIntervalMinutes(intervalOverride, goalIntervalMinutes);
    const lastResponseAt = getLastResponseAt();
    if (!lastResponseAt) {
      goalTimer?.stop();
      return;
    }

    if (!goalTimer || goalTimer.interval !== intervalMinutes) {
      goalTimer?.stop();
      goalTimer = new HeartbeatTimer({
        intervalMinutes,
        messageTemplate: "",
        onFire: () => sendGoalReminder(intervalMinutes),
      });
    }
    goalTimer.start(lastResponseAt);
  }

  function stopGoalTimer(): void {
    goalTimer?.stop();
  }

  function stopAllIdleTimers(): void {
    stopHeartbeat();
    stopGoalTimer();
  }

  /**
   * Set or replace the active idle goal for this session.
   * Persists to session state and arms the goal reminder timer.
   */
  async function setActiveGoal(goal: string | null, intervalOverride?: number): Promise<void> {
    activeGoal = goal;
    goalCreatedAt = goal ? getNowIso() : null;
    goalIntervalMinutes = goal ? resolveIntervalMinutes(intervalOverride, goalIntervalMinutes) : null;

    if (sessionId) {
      await updateSessionState({
        dataDir: getDataDir(),
        sessionId,
        patch: { activeGoal, goalCreatedAt, goalIntervalMinutes },
      }).catch((error) => logError({ dataDir, sessionId, hook: "setActiveGoal", error }));
    }

    if (activeGoal) {
      // Goal reminders take precedence; stop keepalive while a goal is active.
      stopHeartbeat();
      maybeStartGoalTimer(intervalOverride);
      return;
    }

    stopGoalTimer();
    maybeStartHeartbeat();
  }

  /**
   * Mark the current goal as complete. Clears activeGoal and resumes the
   * keepalive heartbeat if it is enabled.
   */
  async function completeGoal(): Promise<void> {
    activeGoal = null;
    goalCreatedAt = null;
    goalIntervalMinutes = null;

    if (sessionId) {
      await updateSessionState({
        dataDir: getDataDir(),
        sessionId,
        patch: { activeGoal: null, goalCreatedAt: null, goalIntervalMinutes: null },
      }).catch((error) => logError({ dataDir, sessionId, hook: "completeGoal", error }));
    }

    stopGoalTimer();
    maybeStartHeartbeat();
  }

  /**
   * Shared toggle for the heartbeat. Used by both the
   * `idle_time_heartbeat_control` tool and the `/idle-time-heartbeat`
   * slash command. Updates in-memory state, persists to global state,
   * and starts/stops the timer.
   *
   * The returned promise resolves once the per-session state write
   * completes. Global state write is fire-and-forget since it does not
   * block subsequent operations.
   *
   * When a goal is active, the keepalive heartbeat is suppressed and the
   * goal reminder timer runs instead. In that case `enabled` is still
   * persisted so the keepalive resumes after the goal completes, but the
   * active timer is the goal reminder.
   */
  function setHeartbeatEnabled(enabled: boolean, minutesOverride?: number): Promise<number> {
    heartbeatEnabled = enabled;
    heartbeatIntervalMinutes = enabled
      ? resolveIntervalMinutes(minutesOverride, heartbeatIntervalMinutes)
      : null;
    const intervalMinutes = resolveIntervalMinutes(minutesOverride, heartbeatIntervalMinutes);

    const sessionWrite = sessionId
      ? updateSessionState({
          dataDir: getDataDir(),
          sessionId,
          patch: { heartbeatEnabled, heartbeatIntervalMinutes },
        }).catch((error) => {
          logError({ dataDir, sessionId, hook: "setHeartbeatEnabled", error });
        })
      : Promise.resolve();

    // Persist globally so heartbeatEnabled survives /reload
    saveGlobalState(getDataDir(), { heartbeatEnabled }).catch((error) =>
      logError({ dataDir, sessionId, hook: "setHeartbeatEnabled", error }),
    );

    if (activeGoal) {
      // Goal reminders take precedence; keepalive will resume after goal completion.
      stopHeartbeat();
      maybeStartGoalTimer(intervalMinutes);
    } else if (heartbeatEnabled) {
      maybeStartHeartbeat(intervalMinutes);
    } else {
      stopHeartbeat();
    }

    return sessionWrite.then(() => intervalMinutes);
  }

  /**
   * Show a UI-only notification about a heartbeat toggle. Uses
   * `ctx.ui.notify` rather than `pi.sendMessage` so the message is
   * NOT added to the LLM context — it's purely a UI state change.
   *
   * The output is formatted to match the compact one-liner style of
   * the keepalive message: leading indent + heart icon in accent
   * color + plain text + dim interval. ANSI codes are hardcoded
   * because the command handler does not receive a theme.
   */
  function sendHeartbeatNotification(
    ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } },
    enabled: boolean,
    intervalMinutes: number,
  ): void {
    try {
      const state = enabled ? "on" : "off";
      // ANSI: 36 = cyan (accent), 2 = dim (muted), 0 = reset
      const ACCENT = "\x1b[36m";
      const DIM = "\x1b[2m";
      const RESET = "\x1b[0m";
      const heart = `${ACCENT}♥${RESET}`;
      const stateText = enabled ? "idle heartbeat on" : "idle heartbeat off";
      const tail = enabled && Number.isFinite(intervalMinutes) && intervalMinutes > 0
        ? ` ${DIM}\u00b7 ${intervalMinutes}m${RESET}`
        : "";
      const text = ` ${heart} ${stateText}${tail}`;
      ctx.ui.notify(text, "info");
    } catch (error) {
      logError({ dataDir, sessionId, hook: "heartbeatNotify", error });
    }
  }

  function updateStatusline(): void {
    if (!setStatusRef) return;

    const config = getConfig();
    const s: StatuslineState = {
      isAgentActive,
      turnStartAt,
      turnDurationFrozen,
      lastStopAt,
      lastAssistantMessageAt,
      currentModelId,
      modelAtLastStop,
      modelAtLastStopAt,
    };
    const result = formatStatusline(s, { dropSecondsAfterSeconds: config.dropSecondsAfterSeconds });
    setStatusRef(STATUSLINE_KEY, result);
  }

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId?.() ?? "default";
    setStatusRef = ctx.ui.setStatus.bind(ctx.ui);
    currentModelId = ctx.model?.id ?? null;

    // Load persisted state for cross-session continuity
    try {
      const persisted = await loadSessionState({ dataDir: getDataDir(), sessionId });
      lastUserPromptAt = persisted.lastUserPromptAt ?? null;
      lastStopAt = persisted.lastStopAt ?? null;
      lastAssistantMessageAt = persisted.lastAssistantMessageAt ?? null;
      lastTurnExecMs = persisted.lastTurnExecMs ?? null;
      modelAtLastStop = persisted.modelAtLastStop ?? null;
      modelAtLastStopAt = persisted.modelAtLastStopAt ?? null;
      heartbeatEnabled = persisted.heartbeatEnabled ?? false;
      heartbeatIntervalMinutes = normalizeIntervalMinutes(persisted.heartbeatIntervalMinutes);
      activeGoal = persisted.activeGoal ?? null;
      goalCreatedAt = persisted.goalCreatedAt ?? null;
      goalIntervalMinutes = normalizeIntervalMinutes(persisted.goalIntervalMinutes);
    } catch (error) {
      logError({ dataDir, sessionId, hook: "session_start", error });
    }

    // Load global state (survives session reloads)
    try {
      const globalState = await loadGlobalState(getDataDir());
      heartbeatEnabled = globalState.heartbeatEnabled;
    } catch (error) {
      logError({ dataDir, sessionId, hook: "session_start", error });
    }

    // Resume goal reminder or heartbeat if either is active
    maybeStartGoalTimer();
    maybeStartHeartbeat();

    // Start statusline refresh
    statuslineTimer = setInterval(updateStatusline, STATUSLINE_REFRESH_MS);
    updateStatusline();
  });

  pi.on("session_shutdown", async () => {
    stopAllIdleTimers();
    if (statuslineTimer) {
      clearInterval(statuslineTimer);
      statuslineTimer = null;
    }
    if (setStatusRef) {
      setStatusRef(STATUSLINE_KEY, undefined);
      setStatusRef = null;
    }
    sessionId = null;
  });

  // --- Input: capture timing, compute idle, inject visible idle message ---

  pi.on("input", async (event, ctx) => {
    if (!sessionId) return;

    // Steering an active agent is not a new user turn; don't reset idle state.
    if (event.streamingBehavior === "steer") return;

    stopAllIdleTimers();

    try {
      const now = getNowIso();
      const isFirstPrompt = !lastUserPromptAt;
      const idleSinceLastStopMs = diffMs(now, lastStopAt);

      // Capture model ID
      currentModelId = ctx.model?.id ?? currentModelId;

      // Build timing block for hidden context injection
      const config = getConfig();
      pendingTimingBlock = formatTimingBlock({
        userMessageTime: now,
        isFirstPrompt,
        idleSinceLastStopMs,
        lastTurnExecMs: lastTurnExecMs ?? undefined,
      });

      // Visible idle system message
      pendingIdleMessage = formatIdleSystemMessage(idleSinceLastStopMs, {
        idleMessageThresholdSeconds: config.idleMessageThresholdSeconds,
        idleMessageDropSecondsAfterSeconds: config.idleMessageDropSecondsAfterSeconds,
        formatHoursAsDays: config.formatHoursAsDays,
      });

      // Update state
      lastUserPromptAt = now;
      lastStopAt = null; // clear so agent_end can measure the next turn
      isAgentActive = true;
      turnStartAt = now;
      turnDurationFrozen = null;

      // Persist the prompt timestamp
      await updateSessionState({
        dataDir: getDataDir(),
        sessionId,
        patch: { lastUserPromptAt: now, lastStopAt: null },
      });

      // Send timing block as a hidden message alongside the user message
      // (not in the system prompt)
      if (pendingTimingBlock) {
        pi.sendMessage(
          {
            customType: "idle-time",
            content: pendingTimingBlock,
            display: false,
          },
          { deliverAs: "followUp" },
        );
      }

      // Show idle time as a TUI notification (not sent to LLM)
      // Delayed slightly so it appears after the user message renders
      if (pendingIdleMessage) {
        const msg = pendingIdleMessage;
        setTimeout(() => ctx.ui.notify(msg, "info"), 10);
      }

      pendingTimingBlock = null;
      pendingIdleMessage = null;

      // Update statusline (will show nothing since lastStopAt is cleared)
      if (setStatusRef) {
        setStatusRef(STATUSLINE_KEY, undefined);
      }
    } catch (error) {
      logError({ dataDir, sessionId, hook: "input", error });
    }
  });

  // --- Agent end: record stop timestamps and turn duration ---

  pi.on("agent_start", async () => {
    if (!sessionId) return;
    stopAllIdleTimers();
  });

  // --- Agent end: record stop timestamps and turn duration ---

  pi.on("agent_end", async () => {
    if (!sessionId) return;

    try {
      const now = getNowIso();
      const isFirstStopInTurn = !lastStopAt;

      // Compute turn execution duration
      const candidate =
        isFirstStopInTurn && lastUserPromptAt ? diffMs(now, lastUserPromptAt) : null;
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
        lastTurnExecMs = candidate;
      }

      lastStopAt = now;
      lastAssistantMessageAt = now;
      modelAtLastStop = currentModelId;
      modelAtLastStopAt = now;
      isAgentActive = false;

      // Freeze turn timer with final duration
      if (turnStartAt) {
        const config = getConfig();
        const elapsedMs = diffMs(now, turnStartAt);
        turnDurationFrozen = formatElapsed(elapsedMs, {
          dropSecondsAfterSeconds: config.dropSecondsAfterSeconds,
        });
        turnStartAt = null;
      }

      // Persist and update statusline without dropping unrelated session fields
      await updateSessionState({
        dataDir: getDataDir(),
        sessionId,
        patch: {
          lastStopAt: now,
          lastAssistantMessageAt: now,
          lastTurnExecMs,
          modelAtLastStop: currentModelId,
          modelAtLastStopAt: now,
        },
      });

      await writeLastResponse({ dataDir: getDataDir(), sessionId, timestamp: now });
      maybeStartGoalTimer();
      maybeStartHeartbeat();
      updateStatusline();
    } catch (error) {
      logError({ dataDir, sessionId, hook: "agent_end", error });
    }
  });

  // --- PreCompact: reset idle timer ---

  pi.on("session_before_compact", async () => {
    if (!sessionId) return;

    try {
      const now = getNowIso();
      lastStopAt = now;
      lastAssistantMessageAt = now;
      modelAtLastStop = null;
      modelAtLastStopAt = null;
      // Clear model tracking
      await updateSessionState({
        dataDir: getDataDir(),
        sessionId,
        patch: {
          lastStopAt: now,
          lastAssistantMessageAt: now,
          modelAtLastStop: null,
          modelAtLastStopAt: null,
        },
      });

      await writeLastResponse({ dataDir: getDataDir(), sessionId, timestamp: now });
      maybeStartGoalTimer();
      maybeStartHeartbeat();
      updateStatusline();
    } catch (error) {
      logError({ dataDir, sessionId, hook: "session_before_compact", error });
    }
  });

  // --- Slash commands ---

  pi.registerCommand("idle-time-reset", {
    description: "Reset idle-time state. Use --all --yes to wipe all sessions.",
    handler: async (args, ctx) => {
      const allFlag = args.includes("--all");
      const yesFlag = args.includes("--yes");

      if (allFlag) {
        if (!yesFlag) {
          ctx.ui.notify("Refusing to wipe all sessions without --yes. Re-run with --all --yes to confirm.", "warning");
          return;
        }

        try {
          const sessionDir = path.join(getDataDir(), "sessions");
          const logDir = path.join(getDataDir(), "logs");
          let removed = 0;

          for (const dir of [sessionDir, logDir]) {
            try {
              const entries = await fs.promises.readdir(dir);
              for (const entry of entries) {
                if (entry.endsWith(".tmp")) continue;
                try {
                  await fs.promises.unlink(path.join(dir, entry));
                  removed++;
                } catch {
                  // ignore
                }
              }
            } catch {
              // dir may not exist
            }
          }

          // Reset in-memory state
          lastUserPromptAt = null;
          lastStopAt = null;
          lastAssistantMessageAt = null;
          lastTurnExecMs = null;
          modelAtLastStop = null;
          modelAtLastStopAt = null;
          heartbeatEnabled = false;
          heartbeatIntervalMinutes = null;
          activeGoal = null;
          goalCreatedAt = null;
          goalIntervalMinutes = null;

          stopAllIdleTimers();
          await saveGlobalState(getDataDir(), { heartbeatEnabled });

          if (setStatusRef) {
            setStatusRef(STATUSLINE_KEY, undefined);
          }

          ctx.ui.notify(`Reset all sessions (${removed} files)`, "info");
        } catch (error) {
          logError({ dataDir, sessionId, hook: "idle-time-reset", error });
          ctx.ui.notify("Failed to reset all sessions", "error");
        }
        return;
      }

      if (!sessionId) {
        ctx.ui.notify("No active session", "error");
        return;
      }

      try {
        const sessionDir = path.join(getDataDir(), "sessions");
        const safeName = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");

        // Remove state file
        try {
          await fs.promises.unlink(path.join(sessionDir, `${safeName}.json`));
        } catch {
          // may not exist
        }

        // Remove .lastresponse file
        try {
          await fs.promises.unlink(path.join(sessionDir, `${safeName}.lastresponse`));
        } catch {
          // may not exist
        }

        // Reset in-memory state
        lastUserPromptAt = null;
        lastStopAt = null;
        lastAssistantMessageAt = null;
        lastTurnExecMs = null;
        modelAtLastStop = null;
        modelAtLastStopAt = null;
        heartbeatEnabled = false;
        heartbeatIntervalMinutes = null;
        activeGoal = null;
        goalCreatedAt = null;
        goalIntervalMinutes = null;

        stopAllIdleTimers();
        await saveGlobalState(getDataDir(), { heartbeatEnabled });

        if (setStatusRef) {
          setStatusRef(STATUSLINE_KEY, undefined);
        }

        ctx.ui.notify(`Idle-time state reset for session ${sessionId}`, "info");
      } catch (error) {
        logError({ dataDir, sessionId, hook: "idle-time-reset", error });
        ctx.ui.notify("Failed to reset idle-time state", "error");
      }
    },
  });

  pi.registerCommand("idle-time-status", {
    description: "Show idle-time plugin status",
    handler: async (_args, ctx) => {
      const config = getConfig();
      const elapsedMs = lastStopAt ? diffMs(getNowIso(), lastStopAt) : null;
      const formatted = elapsedMs != null
        ? formatElapsed(elapsedMs, { dropSecondsAfterSeconds: config.dropSecondsAfterSeconds })
        : null;
      const lastTurnDuration = lastTurnExecMs != null
        ? formatElapsed(lastTurnExecMs, { dropSecondsAfterSeconds: config.dropSecondsAfterSeconds })
        : null;

      const lines = [
        "**idle-time status**",
        "",
        `- Session: \`${sessionId ?? "(none)"}\``,
        `- Data dir: \`${dataDir}\``,
        `- Last stop: ${lastStopAt ?? "(never)"}`,
        `- Last assistant: ${lastAssistantMessageAt ?? "(never)"}`,
        `- Last turn duration: ${lastTurnDuration ?? "(unknown)"}`,
        `- Current idle: ${formatted ?? "(no data)"}`,
        `- Active goal: ${activeGoal ?? "(none)"}`,
        `- Goal interval: ${goalIntervalMinutes ?? "(config/default)"}`,
        `- Heartbeat interval: ${heartbeatIntervalMinutes ?? "(config/default)"}`,
        `- Threshold: ${config.idleMessageThresholdSeconds}s`,
        `- Drop seconds after: ${config.dropSecondsAfterSeconds}s`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("idle-time-config", {
    description: "Show idle-time configuration",
    handler: async (_args, ctx) => {
      const config = getConfig();
      const lines = [
        "**idle-time configuration**",
        "",
        `- idleMessageThresholdSeconds: ${config.idleMessageThresholdSeconds}`,
        `- idleMessageDropSecondsAfterSeconds: ${config.idleMessageDropSecondsAfterSeconds}`,
        `- dropSecondsAfterSeconds: ${config.dropSecondsAfterSeconds}`,
        `- formatHoursAsDays: ${config.formatHoursAsDays}`,
        `- idleHeartbeatMinutes: ${config.idleHeartbeatMinutes ?? "(disabled)"}`,
        `- idleHeartbeatMessage: ${config.idleHeartbeatMessage}`,
        `- heartbeatEnabled (session): ${heartbeatEnabled}`,
        `- heartbeatIntervalMinutes (session): ${heartbeatIntervalMinutes ?? "(config/default)"}`,
        `- activeGoal: ${activeGoal ?? "(none)"}`,
        `- goalIntervalMinutes (session): ${goalIntervalMinutes ?? "(config/default)"}`,
        "",
        `Config file: \`${path.join(dataDir, "config.json")}\``,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("idle-time-heartbeat", {
    description:
      "Toggle the cache keepalive heartbeat. Args: on | off | toggle | status [minutes]. Without args, toggles current state. Persists across /reload.",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = (tokens[0] ?? "toggle").toLowerCase();
      const minutesArg = tokens[1] ? Number(tokens[1]) : undefined;
      if (minutesArg !== undefined && (!Number.isFinite(minutesArg) || minutesArg <= 0)) {
        ctx.ui.notify(
          `Invalid minutes value: \`${tokens[1]}\`. Must be a positive number.`,
          "error",
        );
        return;
      }

      if (action === "status") {
        const interval = getCurrentHeartbeatIntervalMinutes();
        const state = heartbeatEnabled ? "on" : "off";
        ctx.ui.notify(
          `Idle heartbeat is **${state}**` +
            (heartbeatEnabled ? ` (interval: ${interval}m)` : "") +
            ".",
          "info",
        );
        sendHeartbeatNotification(ctx, heartbeatEnabled, interval);
        return;
      }

      let enabled: boolean;
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action === "toggle") enabled = !heartbeatEnabled;
      else {
        ctx.ui.notify(
          `Unknown action: \`${action}\`. Use: on | off | toggle | status [minutes]`,
          "error",
        );
        return;
      }

      const intervalMinutes = await setHeartbeatEnabled(enabled, minutesArg);
      sendHeartbeatNotification(ctx, enabled, intervalMinutes);
    },
  });

  pi.registerCommand("idle-goal", {
    description:
      "Set or manage an idle goal reminder. Args: <description> | --status | --complete. Persists across /reload.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "" || trimmed === "--status") {
        const interval = getCurrentGoalIntervalMinutes();
        if (activeGoal) {
          ctx.ui.notify(
            `🎯 Idle goal active (interval: ${interval}m): ${activeGoal}`,
            "info",
          );
        } else {
          ctx.ui.notify("No active idle goal. Use /idle-goal <description> to set one.", "info");
        }
        return;
      }

      if (trimmed === "--complete") {
        if (!activeGoal) {
          ctx.ui.notify("No active idle goal to complete.", "warning");
          return;
        }
        await completeGoal();
        ctx.ui.notify("🎯 Idle goal marked complete.", "info");
        return;
      }

      await setActiveGoal(trimmed);
      const interval = getCurrentGoalIntervalMinutes();
      ctx.ui.notify(
        `🎯 Idle goal set (interval: ${interval}m): ${trimmed}`,
        "info",
      );
    },
  });

  // --- Heartbeat control tool ---

  pi.registerTool({
    name: "idle_time_heartbeat_control",
    label: "Idle Heartbeat Control",
    description:
      "Enable or disable the idle cache-keepalive heartbeat for this session, and optionally set or complete an idle goal reminder. When enabled and the user is idle for the configured number of minutes, a short keepalive or goal-reminder message is sent. This triggers a real LLM response and consumes tokens.",
    parameters: Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            "Whether the idle heartbeat should be active for this session. Optional when only setting, clearing, or completing an idle goal.",
        }),
      ),
      minutes: Type.Optional(
        Type.Number({
          description:
            "Optional override for the heartbeat interval in minutes. Must be positive. If omitted, the global config value idleHeartbeatMinutes is used.",
          minimum: 0.1,
        }),
      ),
      goal: Type.Optional(
        Type.String({
          description:
            "Optional idle goal description. When provided, a goal reminder replaces the keepalive heartbeat until the goal is completed. Pass an empty string to clear the current goal without completing it.",
        }),
      ),
      completeGoal: Type.Optional(
        Type.Boolean({
          description:
            "Mark the current idle goal as complete. This clears the goal and resumes the keepalive heartbeat if enabled. Ignored if goal is also provided (the new goal takes precedence).",
        }),
      ),
    }),
    renderShell: "self",
    renderCall: (args, theme) => renderHeartbeatCall(args as HeartbeatCallArgs, theme),
    renderResult: (result, options, theme, context) =>
      renderHeartbeatResult(
        (result.details as HeartbeatResultDetails) ?? (context.args as unknown as HeartbeatResultDetails),
        context.isError,
        options.isPartial,
        theme,
      ),
    async execute(_toolCallId, params, _signal, _onUpdate, _toolCtx) {
      let goalActionText = "";
      let intervalMinutes = getCurrentHeartbeatIntervalMinutes();

      if (typeof params.goal === "string") {
        if (params.goal.trim().length === 0) {
          await setActiveGoal(null);
          goalActionText = " Goal cleared.";
        } else {
          await setActiveGoal(params.goal.trim(), params.minutes);
          goalActionText = ` Goal set: ${params.goal.trim()}`;
        }
      } else if (params.completeGoal) {
        if (activeGoal) {
          await completeGoal();
          goalActionText = " Goal marked complete.";
        } else {
          goalActionText = " No active goal to complete.";
        }
      }

      if (typeof params.enabled === "boolean") {
        intervalMinutes = await setHeartbeatEnabled(params.enabled, params.minutes);
      }

      intervalMinutes = activeGoal
        ? getCurrentGoalIntervalMinutes()
        : getCurrentHeartbeatIntervalMinutes();

      const goalSummary = goalActionText.trimStart();
      const summaryText = typeof params.enabled === "boolean"
        ? `Idle heartbeat ${heartbeatEnabled ? "enabled" : "disabled"} for this session.${
            heartbeatEnabled ? ` Interval: ${intervalMinutes} minutes.` : ""
          }${goalActionText}`
        : goalSummary.length > 0
          ? `Idle ${goalSummary.charAt(0).toLowerCase()}${goalSummary.slice(1)}`
          : "No idle-time changes applied.";

      return {
        content: [
          {
            type: "text",
            text: summaryText,
          },
        ],
        details: { enabled: heartbeatEnabled, intervalMinutes, activeGoal, goalActionText },
      };
    },
  });
}
