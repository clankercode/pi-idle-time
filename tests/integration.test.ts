/**
 * Integration tests for the idle-time timing logic.
 *
 * These tests verify the core prompt→stop→prompt sequence by calling the
 * utility functions directly (same logic as the extension, but without
 * needing the Pi runtime).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatTimingBlock, formatIdleSystemMessage } from "../src/format.js";
import { loadSessionState, saveSessionState, updateSessionState, mutateSessionState } from "../src/state.js";
import { getNowIso, diffMs } from "../src/time.js";
import { writeLastResponse, readLastResponse } from "../src/last-response.js";
import { loadConfig } from "../src/config.js";

describe("integration", () => {
  it("prompt, stop, then prompt includes idle and prior execution timing context", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    // First prompt
    const prompt1Time = "2026-04-13T05:00:00.000+10:00";
    const previous1 = await loadSessionState({ dataDir, sessionId });
    const isFirstPrompt1 = !previous1.lastUserPromptAt;

    assert.equal(isFirstPrompt1, true, "first prompt should have no prior lastUserPromptAt");

    const block1 = formatTimingBlock({
      userMessageTime: prompt1Time,
      isFirstPrompt: isFirstPrompt1,
      idleSinceLastStopMs: diffMs(prompt1Time, previous1.lastStopAt),
      lastTurnExecMs: undefined,
    });

    assert.match(block1, /local_time=/);
    assert.match(block1, /\[timing\]/);
    assert.match(block1, /\[\/timing\]/);

    await updateSessionState({
      dataDir,
      sessionId,
      patch: { lastUserPromptAt: prompt1Time, lastStopAt: null },
    });

    // Stop (agent_end)
    const stopTime = "2026-04-13T05:00:04.321+10:00";
    await mutateSessionState({
      dataDir,
      sessionId,
      mutator: (existing) => {
        const candidate = existing.lastUserPromptAt ? diffMs(stopTime, existing.lastUserPromptAt) : null;
        return {
          lastStopAt: stopTime,
          lastAssistantMessageAt: stopTime,
          lastTurnExecMs: typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined,
        };
      },
    });

    await writeLastResponse({ dataDir, sessionId, timestamp: stopTime });

    // Second prompt
    const prompt2Time = "2026-04-13T05:00:19.211+10:00";
    const previous2 = await loadSessionState({ dataDir, sessionId });
    const isFirstPrompt2 = !previous2.lastUserPromptAt;
    const idleMs = diffMs(prompt2Time, previous2.lastStopAt);

    const block2 = formatTimingBlock({
      userMessageTime: prompt2Time,
      isFirstPrompt: isFirstPrompt2,
      idleSinceLastStopMs: idleMs,
      lastTurnExecMs: previous2.lastTurnExecMs,
    });

    assert.equal(block2, ["[timing]", "2026-04-13T05:00:19+10:00", "idle_for=14.9s", "last_turn_dur=4.3s", "[/timing]"].join("\n"));

    // Idle system message should appear for >10s gap
    const config = loadConfig({ dataDir });
    const systemMsg = formatIdleSystemMessage(idleMs, config);
    assert.equal(systemMsg, "[sent after 14s]");
  });

  it("prompt, stop, prompt, stop, then prompt reports the second turn execution duration", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    // Turn 1: prompt
    await updateSessionState({
      dataDir,
      sessionId,
      patch: { lastUserPromptAt: "2026-04-13T05:00:00.000+10:00", lastStopAt: null },
    });

    // Turn 1: stop
    await mutateSessionState({
      dataDir,
      sessionId,
      mutator: (existing) => ({
        lastStopAt: "2026-04-13T05:00:04.321+10:00",
        lastAssistantMessageAt: "2026-04-13T05:00:04.321+10:00",
        lastTurnExecMs: diffMs("2026-04-13T05:00:04.321+10:00", existing.lastUserPromptAt!)!,
      }),
    });

    // Turn 2: prompt
    await updateSessionState({
      dataDir,
      sessionId,
      patch: { lastUserPromptAt: "2026-04-13T05:00:19.211+10:00", lastStopAt: null },
    });

    // Turn 2: stop
    await mutateSessionState({
      dataDir,
      sessionId,
      mutator: (existing) => ({
        lastStopAt: "2026-04-13T05:00:27.654+10:00",
        lastAssistantMessageAt: "2026-04-13T05:00:27.654+10:00",
        lastTurnExecMs: diffMs("2026-04-13T05:00:27.654+10:00", existing.lastUserPromptAt!)!,
      }),
    });

    // Turn 3: prompt — should see idle=32.3s, last_turn_dur=8.4s
    const previous = await loadSessionState({ dataDir, sessionId });
    const idleMs = diffMs("2026-04-13T05:01:00.000+10:00", previous.lastStopAt);

    const block = formatTimingBlock({
      userMessageTime: "2026-04-13T05:01:00.000+10:00",
      isFirstPrompt: false,
      idleSinceLastStopMs: idleMs,
      lastTurnExecMs: previous.lastTurnExecMs,
    });

    assert.equal(block, ["[timing]", "2026-04-13T05:01:00+10:00", "idle_for=32.3s", "last_turn_dur=8.4s", "[/timing]"].join("\n"));

    const config = loadConfig({ dataDir });
    const systemMsg = formatIdleSystemMessage(idleMs, config);
    assert.equal(systemMsg, "[sent after 32s]");
  });

  it("prompt after more than one idle minute includes a visible idle system message", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    // Set up state as if a stop happened 5 minutes ago
    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastStopAt: "2026-04-13T05:00:04.000+10:00",
        lastAssistantMessageAt: "2026-04-13T05:00:04.000+10:00",
        lastTurnExecMs: 4321,
        lastUserPromptAt: "2026-04-13T04:59:00.000+10:00",
      },
    });

    const previous = await loadSessionState({ dataDir, sessionId });
    const now = "2026-04-13T05:05:06.000+10:00";
    const idleMs = diffMs(now, previous.lastStopAt);

    const block = formatTimingBlock({
      userMessageTime: now,
      isFirstPrompt: false,
      idleSinceLastStopMs: idleMs,
      lastTurnExecMs: previous.lastTurnExecMs,
    });

    assert.equal(block, ["[timing]", "2026-04-13T05:05:06+10:00", "idle_for=302.0s", "last_turn_dur=4.3s", "[/timing]"].join("\n"));

    const config = loadConfig({ dataDir });
    const systemMsg = formatIdleSystemMessage(idleMs, config);
    assert.equal(systemMsg, "[sent after 5m 2s]");
  });

  it("lastAssistantMessageAt survives UserPromptSubmit boundary", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    // Simulate: stop happened, then user submitted a new prompt (which clears lastStopAt)
    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastStopAt: null, // cleared by UserPromptSubmit
        lastAssistantMessageAt: "2026-04-12T19:00:00.000Z",
        lastUserPromptAt: "2026-04-12T19:00:30.000Z",
      },
    });

    // The statusline should still be able to count from lastAssistantMessageAt
    const state = await loadSessionState({ dataDir, sessionId });
    const lastResponseAt = state.lastAssistantMessageAt || state.lastStopAt;
    assert.ok(lastResponseAt, "expected lastResponseAt to be set");

    const elapsedMs = diffMs("2026-04-12T19:00:45.000Z", lastResponseAt);
    assert.equal(elapsedMs, 45000);
  });

  it("model tracking fields persist across save/load cycles", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastStopAt: "2026-04-17T12:00:00.000Z",
        lastAssistantMessageAt: "2026-04-17T12:00:00.000Z",
        lastTurnExecMs: 5000,
        modelAtLastStop: "claude-sonnet-4-6",
        modelAtLastStopAt: "2026-04-17T12:00:00.000Z",
      },
    });

    const loaded = await loadSessionState({ dataDir, sessionId });
    assert.equal(loaded.modelAtLastStop, "claude-sonnet-4-6");
    assert.equal(loaded.modelAtLastStopAt, "2026-04-17T12:00:00.000Z");

    // Model change: clear and re-save with new model
    await updateSessionState({
      dataDir,
      sessionId,
      patch: {
        modelAtLastStop: "claude-opus-4-7",
        modelAtLastStopAt: "2026-04-17T12:05:00.000Z",
      },
    });

    const updated = await loadSessionState({ dataDir, sessionId });
    assert.equal(updated.modelAtLastStop, "claude-opus-4-7");
    assert.equal(updated.modelAtLastStopAt, "2026-04-17T12:05:00.000Z");
    assert.equal(updated.lastTurnExecMs, 5000, "other fields should survive");
  });

  it("pre-compact resets idle timer and clears model tracking", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-integration-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastStopAt: "2026-04-17T11:00:00.000Z",
        lastAssistantMessageAt: "2026-04-17T11:00:00.000Z",
        lastTurnExecMs: 1234,
        modelAtLastStop: "claude-sonnet-4-6",
        modelAtLastStopAt: "2026-04-17T11:00:00.000Z",
      },
    });

    // Simulate pre-compact
    const now = "2026-04-17T12:00:00.000Z";
    await updateSessionState({
      dataDir,
      sessionId,
      patch: {
        lastStopAt: now,
        lastAssistantMessageAt: now,
        modelAtLastStop: null,
        modelAtLastStopAt: null,
      },
    });

    await writeLastResponse({ dataDir, sessionId, timestamp: now });

    const state = await loadSessionState({ dataDir, sessionId });
    assert.equal(state.lastStopAt, now);
    assert.equal(state.lastAssistantMessageAt, now);
    assert.equal(state.modelAtLastStop, null);
    assert.equal(state.modelAtLastStopAt, null);
    assert.equal(state.lastTurnExecMs, 1234, "lastTurnExecMs should survive compact");

    const lastResponse = await readLastResponse({ dataDir, sessionId });
    assert.equal(lastResponse, now);
  });
});
