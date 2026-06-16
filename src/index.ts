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
import { loadSessionState, saveSessionState, updateSessionState, type SessionState } from "./state.js";
import { getNowIso, diffMs } from "./time.js";
import { loadConfig, type Config } from "./config.js";
import { logError } from "./log.js";
import { writeLastResponse } from "./last-response.js";
import { formatStatusline, type StatuslineState } from "./statusline.js";
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

  // Timings captured during input, consumed by before_agent_start
  let pendingTimingBlock: string | null = null;
  let pendingIdleMessage: string | null = null;
  let isAgentActive = false;

  let heartbeatTimer: HeartbeatTimer | null = null;

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

  function maybeStartHeartbeat(): void {
    if (!sessionId) return;
    const config = getConfig();
    const intervalMinutes = config.idleHeartbeatMinutes;
    if (!heartbeatEnabled || !intervalMinutes) {
      heartbeatTimer?.stop();
      return;
    }
    const lastResponseAt = lastAssistantMessageAt ?? lastStopAt;
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
            pi.sendUserMessage(message);
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
      lastStopAt = persisted.lastStopAt ?? null;
      lastAssistantMessageAt = persisted.lastAssistantMessageAt ?? null;
      lastTurnExecMs = persisted.lastTurnExecMs ?? null;
      modelAtLastStop = persisted.modelAtLastStop ?? null;
      modelAtLastStopAt = persisted.modelAtLastStopAt ?? null;
      heartbeatEnabled = persisted.heartbeatEnabled ?? false;
    } catch (error) {
      logError({ dataDir, sessionId, hook: "session_start", error });
    }

    // Start statusline refresh
    statuslineTimer = setInterval(updateStatusline, STATUSLINE_REFRESH_MS);
    updateStatusline();
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
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

    stopHeartbeat();

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
        pi.sendMessage({
          customType: "idle-time",
          content: pendingTimingBlock,
          display: false,
        });
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
    stopHeartbeat();
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

      // Persist and update statusline
      await saveSessionState({
        dataDir: getDataDir(),
        sessionId,
        state: {
          lastStopAt: now,
          lastAssistantMessageAt: now,
          lastTurnExecMs,
          modelAtLastStop: currentModelId,
          modelAtLastStopAt: now,
        },
      });

      await writeLastResponse({ dataDir: getDataDir(), sessionId, timestamp: now });
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

      const lines = [
        "**idle-time status**",
        "",
        `- Session: \`${sessionId ?? "(none)"}\``,
        `- Data dir: \`${dataDir}\``,
        `- Last stop: ${lastStopAt ?? "(never)"}`,
        `- Last assistant: ${lastAssistantMessageAt ?? "(never)"}`,
        `- Last turn duration: ${lastTurnExecMs != null ? `${(lastTurnExecMs / 1000).toFixed(1)}s` : "(unknown)"}`,
        `- Current idle: ${formatted ?? "(no data)"}`,
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
        "",
        `Config file: \`${path.join(dataDir, "config.json")}\``,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- Heartbeat control tool ---

  pi.registerTool({
    name: "idle_time_heartbeat_control",
    label: "Idle Heartbeat Control",
    description:
      "Enable or disable the idle cache-keepalive heartbeat for this session. When enabled and the user is idle for the configured number of minutes, a short keepalive message is sent to keep the Anthropic prompt cache warm. This triggers a real LLM response and consumes tokens.",
    parameters: Type.Object({
      enabled: Type.Boolean({
        description: "Whether the idle heartbeat should be active for this session.",
      }),
      minutes: Type.Optional(
        Type.Number({
          description:
            "Optional override for the heartbeat interval in minutes. Must be positive. If omitted, the global config value idleHeartbeatMinutes is used.",
          minimum: 0.1,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
      heartbeatEnabled = params.enabled;

      let intervalMinutes = params.minutes ?? getConfig().idleHeartbeatMinutes ?? 4.5;
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        intervalMinutes = 4.5;
      }

      if (sessionId) {
        try {
          await updateSessionState({
            dataDir: getDataDir(),
            sessionId,
            patch: { heartbeatEnabled },
          });
        } catch (error) {
          logError({ dataDir, sessionId, hook: "idle_time_heartbeat_control", error });
        }
      }

      if (heartbeatEnabled) {
        maybeStartHeartbeat();
      } else {
        stopHeartbeat();
      }

      return {
        content: [
          {
            type: "text",
            text: `Idle heartbeat ${heartbeatEnabled ? "enabled" : "disabled"} for this session.${
              heartbeatEnabled ? ` Interval: ${intervalMinutes} minutes.` : ""
            }`,
          },
        ],
        details: { enabled: heartbeatEnabled, intervalMinutes },
      };
    },
  });
}
