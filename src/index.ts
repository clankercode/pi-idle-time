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
import { formatTimingBlock, formatIdleSystemMessage, type IdleConfig } from "./format.js";
import { formatElapsed } from "./duration.js";
import { loadSessionState, saveSessionState, updateSessionState, type SessionState } from "./state.js";
import { getNowIso, diffMs } from "./time.js";
import { loadConfig, type Config } from "./config.js";
import { logError } from "./log.js";
import { writeLastResponse } from "./last-response.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const STATUSLINE_KEY = "idle-time";
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

  // Timings captured during input, consumed by before_agent_start
  let pendingTimingBlock: string | null = null;
  let pendingIdleMessage: string | null = null;
  let isAgentActive = false;

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

  function updateStatusline(): void {
    if (!setStatusRef) return;

    // Suppress statusline while agent is active (during turns, tool calls, etc.)
    if (isAgentActive) {
      setStatusRef(STATUSLINE_KEY, undefined);
      return;
    }

    // Model change detection: show --- if model changed since last stop
    const effectiveLastResponseAt = lastAssistantMessageAt || lastStopAt;
    if (currentModelId && modelAtLastStopAt && effectiveLastResponseAt === modelAtLastStopAt && modelAtLastStop && currentModelId !== modelAtLastStop) {
      setStatusRef(STATUSLINE_KEY, "---");
      return;
    }

    const lastResponseAt = lastAssistantMessageAt || lastStopAt;
    if (!lastResponseAt) {
      setStatusRef(STATUSLINE_KEY, undefined);
      return;
    }

    const now = getNowIso();
    const elapsedMs = diffMs(now, lastResponseAt);
    const config = getConfig();
    const formatted = formatElapsed(elapsedMs, {
      dropSecondsAfterSeconds: config.dropSecondsAfterSeconds,
    });
    setStatusRef(STATUSLINE_KEY, formatted ?? undefined);
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
    } catch (error) {
      logError({ dataDir, sessionId, hook: "session_start", error });
    }

    // Start statusline refresh
    statuslineTimer = setInterval(updateStatusline, STATUSLINE_REFRESH_MS);
    updateStatusline();
  });

  pi.on("session_shutdown", async () => {
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

  pi.on("input", async (_event, ctx) => {
    if (!sessionId) return;

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
      if (pendingIdleMessage) {
        ctx.ui.notify(pendingIdleMessage, "info");
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
        "",
        `Config file: \`${path.join(dataDir, "config.json")}\``,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
