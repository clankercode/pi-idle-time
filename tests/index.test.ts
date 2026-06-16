/**
 * Tests for the extension entry point.
 *
 * These use a minimal in-memory Pi runtime to verify lifecycle hook behavior,
 * including the bug where steering an active agent incorrectly reset idle state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import idleTimeExtension from "../src/index.js";
import { loadSessionState } from "../src/state.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionStartEvent,
  AgentEndEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createMockPi() {
  const handlers: Record<string, Handler[]> = {};
  const sentMessages: unknown[] = [];
  const tools: unknown[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    sendMessage(message: unknown, _options?: unknown) {
      sentMessages.push({ source: "sendMessage", message });
    },
    sendUserMessage(message: unknown) {
      sentMessages.push({ source: "sendUserMessage", message });
    },
    registerCommand() {
      // no-op
    },
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerMessageRenderer(_customType: string, _renderer: unknown) {
      // no-op
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    sentMessages,
    tools,
    async emit<E>(event: string, payload: E, ctx: ExtensionContext) {
      for (const handler of handlers[event] ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

function createMockCtx(sessionId: string, modelId?: string): ExtensionContext {
  return {
    ui: {
      setStatus: () => {},
      notify: () => {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
    },
    model: modelId ? { id: modelId } : undefined,
  } as unknown as ExtensionContext;
}

describe("idleTimeExtension", () => {
  let originalHome: string | undefined;
  let tmpDir: string;

  before(() => {
    originalHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-time-index-"));
    process.env.HOME = tmpDir;
  });

  after(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("steering an active agent does not reset idle state", async () => {
    const { pi, handlers, sentMessages, emit } = createMockPi();
    const sessionId = "session-steer";
    const ctx = createMockCtx(sessionId, "model-1");

    idleTimeExtension(pi);

    await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);

    // Simulate the assistant finishing a turn so we have a last-stop timestamp.
    await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

    const stateAfterStop = await loadSessionState({
      dataDir: path.join(tmpDir, ".pi", "idle-time"),
      sessionId,
    });
    assert.ok(stateAfterStop.lastStopAt, "expected a lastStopAt after agent_end");

    // Now steer the still-active agent.
    const steerEvent: InputEvent = {
      type: "input",
      text: "focus on the bug",
      source: "interactive",
      streamingBehavior: "steer",
    };
    await emit<InputEvent>("input", steerEvent, ctx);

    const stateAfterSteer = await loadSessionState({
      dataDir: path.join(tmpDir, ".pi", "idle-time"),
      sessionId,
    });

    assert.equal(
      stateAfterSteer.lastStopAt,
      stateAfterStop.lastStopAt,
      "steer should not reset lastStopAt",
    );
    assert.equal(sentMessages.length, 0, "steer should not inject a timing block");

    await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("a normal user input resets idle state and injects timing context", async () => {
    const { pi, handlers, sentMessages, emit } = createMockPi();
    const sessionId = "session-input";
    const ctx = createMockCtx(sessionId, "model-1");

    idleTimeExtension(pi);

    await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);

    await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

    const stateAfterStop = await loadSessionState({
      dataDir: path.join(tmpDir, ".pi", "idle-time"),
      sessionId,
    });
    assert.ok(stateAfterStop.lastStopAt, "expected a lastStopAt after agent_end");

    // Wait a tiny bit so the prompt is measurably after the stop.
    await new Promise((resolve) => setTimeout(resolve, 15));

    const inputEvent: InputEvent = {
      type: "input",
      text: "hello",
      source: "interactive",
    };
    await emit<InputEvent>("input", inputEvent, ctx);

    const stateAfterInput = await loadSessionState({
      dataDir: path.join(tmpDir, ".pi", "idle-time"),
      sessionId,
    });

    assert.equal(stateAfterInput.lastStopAt, null, "normal input should clear lastStopAt");
    assert.equal(sentMessages.length, 1, "normal input should inject a timing block");
    const sent = sentMessages[0] as { source: string; message: { customType: string } };
    assert.equal(sent.source, "sendMessage");
    assert.deepEqual(sent.message.customType, "idle-time");

    await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("registers the heartbeat control tool", () => {
    const { pi, tools } = createMockPi();
    idleTimeExtension(pi);
    const toolNames = tools.map((t) => (t as { name: string }).name);
    assert.ok(toolNames.includes("idle_time_heartbeat_control"));
  });

  it("heartbeat tool toggles enabled state and persists it", async () => {
    const { pi, tools, emit } = createMockPi();
    const sessionId = "session-hb";
    const ctx = createMockCtx(sessionId, "model-1");

    idleTimeExtension(pi);

    await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
    await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

    const tool = tools.find((t) => (t as { name: string }).name === "idle_time_heartbeat_control") as {
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    };
    assert.ok(tool, "expected heartbeat control tool");

    const result = await tool.execute("call-1", { enabled: true, minutes: 4.5 });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Idle heartbeat enabled for this session. Interval: 4.5 minutes." }],
      details: { enabled: true, intervalMinutes: 4.5 },
    });

    const state = await loadSessionState({
      dataDir: path.join(tmpDir, ".pi", "idle-time"),
      sessionId,
    });
    assert.equal(state.heartbeatEnabled, true);

    await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });
});
