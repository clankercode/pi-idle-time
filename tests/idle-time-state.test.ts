/**
 * Tests for the agent-visible idle-time state event helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatIdleTimeStateBody,
  sendIdleTimeStateEvent,
  registerIdleTimeStateRenderer,
  IDLE_TIME_STATE_CUSTOM_TYPE,
  type IdleTimeStateEvent,
  type IdleTimeStateFields,
} from "../src/idle-time-state.js";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function makeSender() {
  const sent: { message: unknown; options?: unknown }[] = [];
  return {
    sender: {
      sendMessage(message: unknown, options?: unknown) {
        sent.push({ message, options });
      },
    },
    sent,
  };
}

type RegisteredRenderer = (...args: unknown[]) => unknown;

function makePi() {
  const renderers = new Map<string, RegisteredRenderer>();
  const pi = {
    registerMessageRenderer(
      customType: string,
      renderer: RegisteredRenderer,
    ) {
      renderers.set(customType, renderer);
    },
  } as unknown as ExtensionAPI;
  return { pi, renderers };
}


describe("idle-time-state", () => {
  describe("formatIdleTimeStateBody", () => {
    it("renders the change line first then key=value fields in declared order", () => {
      const event: IdleTimeStateEvent = {
        change: "goal-set",
        fields: {
          heartbeat_enabled: true,
          heartbeat_interval_minutes: 4.5,
          active_goal: "refactor the auth module",
          goal_interval_minutes: 4.5,
        },
      };
      assert.equal(
        formatIdleTimeStateBody(event),
        [
          "[idle-time status]",
          "change=goal-set",
          "heartbeat_enabled=true",
          "heartbeat_interval_minutes=4.5",
          "active_goal=refactor the auth module",
          "goal_interval_minutes=4.5",
        ].join("\n"),
      );
    });

    it("renders null goal as (none) so the agent sees an explicit cleared state", () => {
      const body = formatIdleTimeStateBody({
        change: "goal-cleared",
        fields: { active_goal: null },
      });
      assert.match(body, /active_goal=\(none\)/);
    });

    it("omits fields that are undefined", () => {
      const body = formatIdleTimeStateBody({
        change: "heartbeat-enabled",
        fields: { heartbeat_enabled: true },
      });
      assert.doesNotMatch(body, /active_goal=/);
      assert.doesNotMatch(body, /goal_interval_minutes=/);
    });
  });

  describe("sendIdleTimeStateEvent", () => {
    it("returns false when there is no sender", () => {
      const sent = sendIdleTimeStateEvent(null, {
        change: "heartbeat-enabled",
        fields: { heartbeat_enabled: true },
      });
      assert.equal(sent, false);
    });

    it("sends a custom message with the expected body and followUp delivery options", () => {
      const { sender, sent } = makeSender();
      const ok = sendIdleTimeStateEvent(sender, {
        change: "heartbeat-enabled",
        fields: {
          heartbeat_enabled: true,
          heartbeat_interval_minutes: 4.5,
          active_goal: null,
          goal_interval_minutes: null,
        } as IdleTimeStateFields,
      });
      assert.equal(ok, true);
      assert.equal(sent.length, 1);
      const entry = sent[0] as { message: { customType: string; content: string; display: boolean }; options: unknown };
      assert.equal(entry.message.customType, IDLE_TIME_STATE_CUSTOM_TYPE);
      assert.equal(entry.message.display, true);
      assert.match(entry.message.content, /change=heartbeat-enabled/);
      assert.match(entry.message.content, /heartbeat_enabled=true/);
      assert.deepEqual(entry.options, { triggerTurn: true, deliverAs: "followUp" });
    });

    it("can be told to skip the send (no message dispatched)", () => {
      const { sender, sent } = makeSender();
      const ok = sendIdleTimeStateEvent(
        sender,
        { change: "goal-complete", fields: {} },
        { send: false },
      );
      assert.equal(ok, false);
      assert.equal(sent.length, 0);
    });

    it("swallow sender errors so the caller can continue", () => {
      const sender = {
        sendMessage() {
          throw new Error("boom");
        },
      };
      const ok = sendIdleTimeStateEvent(sender, {
        change: "reset-session",
        fields: { heartbeat_enabled: false },
      });
      assert.equal(ok, false);
    });
  });

  describe("registerIdleTimeStateRenderer", () => {
    it("returns a one-line summary when collapsed", () => {
      const { pi, renderers } = makePi();
      registerIdleTimeStateRenderer(pi);
      const renderer = renderers.get(IDLE_TIME_STATE_CUSTOM_TYPE);
      assert.ok(renderer, "expected renderer registration");
      const body = [
        "[idle-time status]",
        "change=goal-set",
        "heartbeat_enabled=true",
        "heartbeat_interval_minutes=4.5",
        "active_goal=refactor the auth module",
        "goal_interval_minutes=4.5",
      ].join("\n");
      const result = ((renderer as unknown as Function)({ content: body }, { expanded: false }, {})) as Text;
      assert.ok(result instanceof Text);
      const lines = result.render(80) as string[];
      assert.equal(lines.length, 1);
      assert.match(lines[0], /goal-set/);
      assert.match(lines[0], /hb=true/);
      assert.match(lines[0], /goal=refactor the auth module/);
    });

    it("returns the full key=value body when expanded", () => {
      const { pi, renderers } = makePi();
      registerIdleTimeStateRenderer(pi);
      const renderer = renderers.get(IDLE_TIME_STATE_CUSTOM_TYPE);
      assert.ok(renderer, "expected renderer registration");
      const body = [
        "[idle-time status]",
        "change=goal-cleared",
        "heartbeat_enabled=true",
        "heartbeat_interval_minutes=4.5",
        "active_goal=(none)",
      ].join("\n");
      const expanded = ((renderer as unknown as Function)({ content: body }, { expanded: true }, {})) as Text;
      const lines = expanded.render(120) as string[];
      assert.ok(lines.length > 1, `expected expanded view with multiple lines, got ${lines.length}`);
      assert.match(lines.join("\n"), /heartbeat_enabled=true/);
      assert.match(lines.join("\n"), /active_goal=\(none\)/);
      // The change= line is suppressed in expanded mode because the header
      // already summarizes the change.
      assert.doesNotMatch(lines[0], /change=/);
    });

    it("returns undefined when the body is empty", () => {
      const { pi, renderers } = makePi();
      registerIdleTimeStateRenderer(pi);
      const renderer = renderers.get(IDLE_TIME_STATE_CUSTOM_TYPE);
      assert.ok(renderer, "expected renderer registration");
      const result = (renderer as unknown as Function)({ content: "" }, { expanded: false }, {});
      assert.equal(result, undefined);
    });
  });
});
