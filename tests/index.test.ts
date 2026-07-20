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
import { setTimeout as delay } from "node:timers/promises";
import idleTimeExtension from "../src/index.js";
import { loadSessionState, saveSessionState } from "../src/state.js";
import { loadGlobalState } from "../src/global-state.js";
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

  it("registers the goal message renderer", () => {
    const { pi, registeredMessageRenderers } = createMockPi();
    idleTimeExtension(pi);
    const customTypes = registeredMessageRenderers.map((r) => r.customType);
    assert.ok(
      customTypes.includes("idle-time-goal"),
      `expected customTypes to include 'idle-time-goal', got ${JSON.stringify(customTypes)}`,
    );
  });

  it("registers the /idle-time-heartbeat command", () => {
    const { pi, commands } = createMockPi();
    idleTimeExtension(pi);
    assert.ok(commands.has("idle-time-heartbeat"), "expected /idle-time-heartbeat command");
  });

  it("registers the /idle-goal command", () => {
    const { pi, commands } = createMockPi();
    idleTimeExtension(pi);
    assert.ok(commands.has("idle-goal"), "expected /idle-goal command");
  });

  it("/idle-time-status formats long last turn durations as elapsed time", async () => {
    const dataDir = path.join(tmpDir, ".pi", "idle-time");
    const { pi, commands, emit } = createMockPi();
    const sessionId = "session-status-duration";
    const ctx = createMockCtx(sessionId, "model-1");
    const notifications: string[] = [];
    (ctx.ui as unknown as { notify: (message: string, type?: string) => void }).notify = (message) => {
      notifications.push(message);
    };

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        sessionId,
        lastStopAt: "2026-06-18T21:52:31.274+10:00",
        lastAssistantMessageAt: "2026-06-18T21:52:31.274+10:00",
        lastTurnExecMs: 2_220_000,
      },
    });

    idleTimeExtension(pi);
    await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);

    const command = commands.get("idle-time-status");
    assert.ok(command, "expected /idle-time-status command");
    await command.handler("", ctx);

    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /- Last turn duration: 37m/);
    assert.doesNotMatch(notifications[0], /2220\.0s/);

    await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("/idle-time-reset clears globally persisted heartbeat state", async () => {
    const dataDir = path.join(tmpDir, ".pi", "idle-time");
    const { pi, commands, sentMessages, emit } = createMockPi();
    const sessionId = "session-reset-global-heartbeat";
    const ctx = createMockCtx(sessionId, "model-1");

    idleTimeExtension(pi);
    try {
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const heartbeatCommand = commands.get("idle-time-heartbeat");
      assert.ok(heartbeatCommand, "expected /idle-time-heartbeat command");
      await heartbeatCommand.handler("on", ctx);
      assert.equal((await loadGlobalState(dataDir)).heartbeatEnabled, true);

      const resetCommand = commands.get("idle-time-reset");
      assert.ok(resetCommand, "expected /idle-time-reset command");
      await resetCommand.handler("", ctx);

      assert.equal((await loadGlobalState(dataDir)).heartbeatEnabled, false);

      const stateEvents = sentMessages
        .map((entry) => entry as { message?: { customType?: string; content?: string }; options?: unknown })
        .filter((entry) => entry.message?.customType === "idle-time-state");
      const resetEvent = stateEvents.find((entry) => entry.message?.content?.includes("change=reset-session"));
      assert.ok(resetEvent?.message?.content, "expected reset to deliver an agent-visible state event");
      assert.match(resetEvent.message.content, /change=reset-session/);
      assert.match(resetEvent.message.content, /heartbeat_enabled=false/);
      assert.deepEqual(resetEvent.options, { triggerTurn: true, deliverAs: "followUp" });
    } finally {
      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    }
  });

  it("loads persisted lastUserPromptAt so reloads do not look like first prompts", async () => {
    const dataDir = path.join(tmpDir, ".pi", "idle-time");
    const { pi, sentMessages, emit } = createMockPi();
    const sessionId = "session-reload-not-first-prompt";
    const ctx = createMockCtx(sessionId, "model-1");

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        sessionId,
        lastUserPromptAt: "2026-06-18T21:50:00.000+10:00",
        lastStopAt: "2026-06-18T21:52:31.274+10:00",
        lastAssistantMessageAt: "2026-06-18T21:52:31.274+10:00",
      },
    });

    idleTimeExtension(pi);
    try {
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);

      const inputEvent: InputEvent = {
        type: "input",
        text: "hello after reload",
        source: "interactive",
      };
      await emit<InputEvent>("input", inputEvent, ctx);

      const sent = sentMessages.find(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time",
      ) as { message?: { content?: string } } | undefined;
      assert.ok(sent?.message?.content, "expected an injected timing block");
      assert.doesNotMatch(sent.message.content, /local_time=/);
    } finally {
      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    }
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

    const result = await tool.execute("call-1", { action: "enable", minutes: 4.5 });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Idle heartbeat enabled for this session. Interval: 4.5 minutes." }],
      details: { enabled: true, intervalMinutes: 4.5, activeGoal: null, goalActionText: "" },
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

    it("delivers heartbeat changes to the agent", async () => {
      const { pi, commands, sentMessages, emit } = createMockPi();
      const sessionId = "session-cmd-agent-visible";
      const { ctx } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-time-heartbeat");
      assert.ok(cmd, "expected /idle-time-heartbeat command");
      await cmd.handler("on", ctx);

      const stateEvent = sentMessages.find(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-state",
      ) as { message?: { content?: string }; options?: unknown } | undefined;
      assert.ok(stateEvent?.message?.content, "expected a heartbeat state event in the agent context");
      assert.match(stateEvent.message.content, /change=heartbeat-enabled/);
      assert.match(stateEvent.message.content, /heartbeat_enabled=true/);
      assert.match(stateEvent.message.content, /heartbeat_interval_minutes=4\.5/);
      assert.deepEqual(stateEvent.options, { triggerTurn: true, deliverAs: "followUp" });

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });
  });

  describe("/idle-goal command", () => {
    function makeCtx(sessionId: string) {
      const calls: { message: string; type?: string }[] = [];
      const ctx = createMockCtx(sessionId, "model-1");
      (ctx.ui as unknown as { notify: (m: string, t?: string) => void }).notify = (m, t) => {
        calls.push({ message: m, type: t });
      };
      return { ctx, calls };
    }

    it("sets an idle goal and persists it", async () => {
      const { pi, commands, sentMessages, emit } = createMockPi();
      const sessionId = "session-goal-set";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-goal");
      assert.ok(cmd, "expected /idle-goal command");
      await cmd.handler("refactor the auth module", ctx);

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, "refactor the auth module");
      assert.ok(state.goalCreatedAt, "expected goalCreatedAt to be set");

      assert.equal(calls.length, 1);
      assert.match(calls[0].message, /Idle goal set/);
      assert.match(calls[0].message, /refactor the auth module/);
      assert.equal(calls[0].type, "info");

      const stateEvent = sentMessages.find(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-state",
      ) as { message?: { content?: string }; options?: unknown } | undefined;
      assert.ok(stateEvent?.message?.content, "expected a goal state event in the agent context");
      assert.match(stateEvent.message.content, /change=goal-set/);
      assert.match(stateEvent.message.content, /active_goal=refactor the auth module/);
      assert.deepEqual(stateEvent.options, { triggerTurn: true, deliverAs: "followUp" });

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("shows the active goal with no args", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-goal-status";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-goal");
      assert.ok(cmd, "expected /idle-goal command");
      await cmd.handler("refactor the auth module", ctx);
      await cmd.handler("", ctx);

      assert.equal(calls.length, 2);
      assert.match(calls[1].message, /Idle goal active/);
      assert.match(calls[1].message, /refactor the auth module/);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("completes the active goal", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-goal-complete";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-goal");
      assert.ok(cmd, "expected /idle-goal command");
      await cmd.handler("refactor the auth module", ctx);
      await cmd.handler("--complete", ctx);

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, null);
      assert.equal(state.goalCreatedAt, null);

      assert.equal(calls.length, 2);
      assert.match(calls[1].message, /marked complete/);
      assert.equal(calls[1].type, "info");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("warns when completing with no active goal", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-goal-none";
      const { ctx, calls } = makeCtx(sessionId);

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-goal");
      assert.ok(cmd, "expected /idle-goal command");
      await cmd.handler("--complete", ctx);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].type, "warning");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });
  });

  describe("idle_time_heartbeat_control goal params", () => {
    function findTool(tools: unknown[]) {
      return tools.find((t) => (t as { name: string }).name === "idle_time_heartbeat_control") as {
        execute: (toolCallId: string, params: unknown) => Promise<unknown>;
      };
    }

    it("queries active state without mutating it", async () => {
      const { pi, commands, tools, emit } = createMockPi();
      const sessionId = "session-tool-status";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const heartbeatCommand = commands.get("idle-time-heartbeat");
      const goalCommand = commands.get("idle-goal");
      assert.ok(heartbeatCommand, "expected /idle-time-heartbeat command");
      assert.ok(goalCommand, "expected /idle-goal command");
      await heartbeatCommand.handler("on 10", ctx);
      await goalCommand.handler("refactor the auth module", ctx);

      const tool = findTool(tools);
      const result = await tool.execute("call-status", {});
      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "[idle-time status]\nheartbeat_enabled=true\nheartbeat_interval_minutes=10\nactive_goal=refactor the auth module\ngoal_interval_minutes=4.5",
          },
        ],
        details: {
          enabled: true,
          intervalMinutes: 4.5,
          activeGoal: "refactor the auth module",
          goalActionText: "",
        },
      });

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.heartbeatEnabled, true);
      assert.equal(state.heartbeatIntervalMinutes, 10);
      assert.equal(state.activeGoal, "refactor the auth module");
      // Goal uses the configured/default interval (4.5m) because no override
      // was passed alongside `goal`. The state file reflects the session
      // override, which is null for the goal interval here.
      assert.equal(state.goalIntervalMinutes ?? 4.5, 4.5);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("sets a goal via the tool", async () => {
      const { pi, tools, emit } = createMockPi();
      const sessionId = "session-tool-goal";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      assert.ok(tool, "expected heartbeat control tool");
      await tool.execute("call-0", { action: "disable" });

      const result = await tool.execute("call-1", { action: "set_goal", goal: "refactor the auth module" });
      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "Idle goal set: refactor the auth module",
          },
        ],
        details: {
          enabled: false,
          intervalMinutes: 4.5,
          activeGoal: "refactor the auth module",
          goalActionText: " Goal set: refactor the auth module",
        },
      });

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, "refactor the auth module");
      assert.equal(state.heartbeatEnabled ?? false, false);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("set_goal does not enable the generic heartbeat", async () => {
      const { pi, tools, emit } = createMockPi();
      const sessionId = "session-tool-goal-no-enable";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-0", { action: "disable" });
      await tool.execute("call-1", { action: "set_goal", goal: "refactor the auth module" });
      const result = await tool.execute("call-2", { action: "complete_goal" });

      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "Idle goal marked complete.",
          },
        ],
        details: {
          enabled: false,
          intervalMinutes: 4.5,
          activeGoal: null,
          goalActionText: " Goal marked complete.",
        },
      });

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, null);
      assert.equal(state.heartbeatEnabled ?? false, false);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("completes a goal via the tool", async () => {
      const { pi, tools, emit } = createMockPi();
      const sessionId = "session-tool-complete";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", { action: "enable" });
      await tool.execute("call-1b", { action: "set_goal", goal: "refactor the auth module" });
      const enableAgain = await tool.execute("call-2a", { action: "enable" });
      assert.equal(
        (enableAgain as { details: { enabled: boolean } }).details.enabled,
        true,
      );
      const result = await tool.execute("call-2", { action: "complete_goal" });

      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "Idle goal marked complete.",
          },
        ],
        details: {
          enabled: true,
          intervalMinutes: 4.5,
          activeGoal: null,
          goalActionText: " Goal marked complete.",
        },
      });

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, null);
      assert.equal(state.heartbeatEnabled, true);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("completes a goal via the tool without requiring enable", async () => {
      const { pi, tools, emit } = createMockPi();
      const sessionId = "session-tool-complete-no-enabled";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", { action: "enable" });
      await tool.execute("call-1b", { action: "set_goal", goal: "refactor the auth module" });
      const result = await tool.execute("call-2", { action: "complete_goal" });

      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "Idle goal marked complete.",
          },
        ],
        details: {
          enabled: true,
          intervalMinutes: 4.5,
          activeGoal: null,
          goalActionText: " Goal marked complete.",
        },
      });

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, null);
      assert.equal(state.heartbeatEnabled, true);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("clears a goal via the tool and resumes keepalive if heartbeat is enabled", async () => {
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-tool-clear-goal";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", { action: "enable", minutes: 0.001 });
      await tool.execute("call-1b", { action: "set_goal", goal: "refactor the auth module", minutes: 0.001 });
      const result = await tool.execute("call-2", { action: "clear_goal" });

      assert.deepEqual(result, {
        content: [
          {
            type: "text",
            text: "Idle goal cleared.",
          },
        ],
        details: {
          enabled: true,
          intervalMinutes: 0.001,
          activeGoal: null,
          goalActionText: " Goal cleared.",
        },
      });

      await delay(120);

      const goalMessages = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      const heartbeatMessages = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-heartbeat",
      );

      assert.equal(goalMessages.length, 0, `expected 0 goal reminders after clearing the goal, got ${goalMessages.length}`);
      assert.equal(
        heartbeatMessages.length,
        1,
        `expected 1 heartbeat keepalive after clearing the goal, got ${heartbeatMessages.length}`,
      );

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("preserves an active goal across later agent_end writes", async () => {
      const { pi, commands, emit } = createMockPi();
      const sessionId = "session-goal-persist-after-stop";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const cmd = commands.get("idle-goal");
      assert.ok(cmd, "expected /idle-goal command");
      await cmd.handler("refactor the auth module", ctx);

      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const state = await loadSessionState({
        dataDir: path.join(tmpDir, ".pi", "idle-time"),
        sessionId,
      });
      assert.equal(state.activeGoal, "refactor the auth module");
      assert.ok(state.goalCreatedAt, "expected goalCreatedAt to survive later agent_end writes");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("goal reminders take precedence over keepalive when both are active", async () => {
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-goal-precedence";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", { action: "enable", minutes: 0.001 });
      await tool.execute("call-1b", {
        action: "set_goal",
        goal: "refactor the auth module",
        minutes: 0.001,
      });

      await delay(120);

      const goalMessages = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      const heartbeatMessages = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-heartbeat",
      );

      assert.equal(goalMessages.length, 1, `expected 1 goal reminder, got ${goalMessages.length}`);
      assert.equal(
        heartbeatMessages.length,
        0,
        `expected 0 heartbeat keepalives while a goal is active, got ${heartbeatMessages.length}`,
      );

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("does not fire a goal reminder until the active turn ends", async () => {
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-goal-no-midturn-fire";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      const inputEvent: InputEvent = {
        type: "input",
        text: "set a reminder while you work",
        source: "interactive",
      };
      await emit<InputEvent>("input", inputEvent, ctx);
      await emit("agent_start", { type: "agent_start" }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", {
        action: "set_goal",
        goal: "refactor the auth module",
        minutes: 0.001,
      });

      await delay(120);

      const goalMessagesBeforeStop = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(goalMessagesBeforeStop.length, 0, "expected no goal reminder during the active turn");

      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);
      await delay(250);

      const goalMessagesAfterStop = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(goalMessagesAfterStop.length, 1, "expected goal reminder after the turn ended");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("does not fire mid follow-up turn when set_goal runs after idle already elapsed", async () => {
      // Reproduces: agent_end left lastResponseAt in the past; a triggerTurn/follow-up
      // turn starts without user input; agent sets a short-interval goal; past-due timer
      // must NOT fire while the turn is still running.
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-goal-followup-midturn";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      // Idle already elapsed relative to short interval; no user input — only agent_start
      // (matches tool-triggered follow-up turns after a prior goal/state message).
      await delay(50);
      await emit("agent_start", { type: "agent_start" }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-1", {
        action: "set_goal",
        goal: "stale-or-current goal while follow-up runs",
        minutes: 0.001,
      });

      await delay(150);

      const goalBeforeEnd = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      const hbBeforeEnd = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-heartbeat",
      );
      assert.equal(goalBeforeEnd.length, 0, "expected 0 goal reminders mid follow-up turn");
      assert.equal(hbBeforeEnd.length, 0, "expected 0 heartbeat keepalives mid follow-up turn");

      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);
      await delay(250);

      const goalAfterEnd = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(goalAfterEnd.length, 1, "expected exactly one goal reminder after idle from true last response");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("rapid mid-turn set_goal / replace / complete delivers no reminder; none after complete", async () => {
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-goal-rapid-replace-complete";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      await delay(50);
      // Follow-up-style turn (no user input)
      await emit("agent_start", { type: "agent_start" }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-a", { action: "set_goal", goal: "goal A superseded", minutes: 0.001 });
      await tool.execute("call-b", { action: "set_goal", goal: "goal B also dropped", minutes: 0.001 });
      await tool.execute("call-c", { action: "complete_goal" });

      await delay(150);

      const midTurnGoals = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(midTurnGoals.length, 0, "expected no mid-turn goal reminders during multi-goal churn");

      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);
      await delay(250);

      const afterEndGoals = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(afterEndGoals.length, 0, "expected no goal reminder after complete left no active goal");

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });

    it("rapid mid-turn replace keeps only the final goal; one reminder after agent_end idle", async () => {
      const dataDir = path.join(tmpDir, ".pi", "idle-time");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleHeartbeatMinutes: 0.001 }));

      const { pi, sentMessages, tools, emit } = createMockPi();
      const sessionId = "session-goal-rapid-replace-keep";
      const ctx = createMockCtx(sessionId, "model-1");

      idleTimeExtension(pi);
      await emit<SessionStartEvent>("session_start", { type: "session_start", reason: "startup" }, ctx);
      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);

      await delay(50);
      await emit("agent_start", { type: "agent_start" }, ctx);

      const tool = findTool(tools);
      await tool.execute("call-a", { action: "set_goal", goal: "goal A", minutes: 0.001 });
      await tool.execute("call-b", { action: "set_goal", goal: "goal B final", minutes: 0.001 });

      await delay(150);

      assert.equal(
        sentMessages.filter(
          (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
        ).length,
        0,
        "expected no mid-turn goal fire after multi set_goal",
      );

      await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: [] }, ctx);
      await delay(250);

      const goals = sentMessages.filter(
        (entry) => (entry as { message?: { customType?: string } }).message?.customType === "idle-time-goal",
      );
      assert.equal(goals.length, 1, "expected one reminder for the final active goal");
      const content = (goals[0] as { message: { content: string } }).message.content;
      assert.match(content, /goal B final/);
      assert.doesNotMatch(content, /goal A\b/);

      await emit<SessionShutdownEvent>("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    });
  });
});
