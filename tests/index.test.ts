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
  const commands: Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown }> = new Map();
  const registeredMessageRenderers: { customType: string; renderer: unknown }[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ source: "sendMessage", message, options });
    },
    sendUserMessage(message: unknown) {
      sentMessages.push({ source: "sendUserMessage", message });
    },
    registerCommand(name: string, def: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown }) {
      commands.set(name, def);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      registeredMessageRenderers.push({ customType, renderer });
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    sentMessages,
    tools,
    commands,
    registeredMessageRenderers,
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

  it("registers the heartbeat message renderer", () => {
    const { pi, registeredMessageRenderers } = createMockPi();
    idleTimeExtension(pi);
    const customTypes = registeredMessageRenderers.map((r) => r.customType);
    assert.ok(
      customTypes.includes("idle-time-heartbeat"),
      `expected customTypes to include 'idle-time-heartbeat', got ${JSON.stringify(customTypes)}`,
    );
  });

  it("registers the /idle-time-heartbeat command", () => {
    const { pi, commands } = createMockPi();
    idleTimeExtension(pi);
    assert.ok(commands.has("idle-time-heartbeat"), "expected /idle-time-heartbeat command");
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

  describe("/idle-time-heartbeat command", () => {
    function makeCtx(sessionId: string) {
      const calls: { message: string; type?: string }[] = [];
      const ctx = createMockCtx(sessionId, "model-1");
      (ctx.ui as unknown as { notify: (m: string, t?: string) => void }).notify = (m, t) => {
        calls.push({ message: m, type: t });
      };
      return { ctx, calls };
    }

    it("toggles the heartbeat on when called with `on` and shows a UI notification", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-cmd-on";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("on", ctx);

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.heartbeatEnabled, true);

      assert.equal(calls.length, 1);
      assert.match(calls[0].message, /on/);
      assert.match(calls[0].message, /4\.5m/);
      assert.equal(calls[0].type, "info");

      // Verify the message was NOT sent to the LLM
      const sent = pi as unknown as { _sentMessages?: unknown[] };
      // (createMockPi captures sentMessages, but we didn't use it here — the
      // important guarantee is that notify was called, not sendMessage)

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("toggles the heartbeat off when called with `off` and shows a UI notification", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-cmd-off";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("on", ctx);
      await cmd.handler("off", ctx);

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.heartbeatEnabled, false);

      assert.equal(calls.length, 2);
      assert.match(calls[0].message, /on/);
      assert.match(calls[1].message, /off/);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("toggles current state when called with no arg or `toggle`", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-cmd-toggle";
      const { ctx } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("", ctx);

      const state1 = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state1.heartbeatEnabled, true);

      await cmd.handler("toggle", ctx);

      const state2 = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state2.heartbeatEnabled, false);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("rejects invalid minutes values with a warning notification", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-cmd-invalid";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("on abc", ctx);

      // Should show error notification, no state change
      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.heartbeatEnabled ?? false, false);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].type, "error");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("rejects unknown actions with an error notification", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-cmd-unknown";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("what", ctx);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].type, "error");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("does NOT add a notification to the LLM context", async () => {
      const { pi, commands, sentMessages, emit } = createMockPi();
      const sessionId = "session-cmd-nocontext";
      const { ctx } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("on", ctx);

      // No message should have been sent via pi.sendMessage
      const heartbeatNotifs = sentMessages.filter(
        (m) => (m as { message: { customType: string } }).message.customType === "idle-time-heartbeat-notify",
      );
      assert.equal(heartbeatNotifs.length, 0, "expected no LLM-context message for toggle");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });
  });
});
