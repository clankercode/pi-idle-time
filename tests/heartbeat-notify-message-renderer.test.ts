/**
 * Tests for the compact [idle-time-heartbeat-notify] toggle notification renderer.
 *
 * Mirrors the pattern in `tests/heartbeat-message-renderer.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CompactHeartbeatNotify,
  buildCompactLine,
  buildExpandedComponent,
  CUSTOM_TYPE,
  type HeartbeatNotifyDetails,
} from "../src/heartbeat-notify-message-renderer.js";

const plainTheme = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function makeMessage(
  content: string,
  details: Partial<HeartbeatNotifyDetails> = {},
) {
  return {
    content,
    details: { enabled: true, intervalMinutes: 4.5, source: "command", ...details } as HeartbeatNotifyDetails,
  };
}

describe("heartbeat-notify-message-renderer", () => {
  it("exports the customType used by pi.sendMessage", () => {
    assert.equal(CUSTOM_TYPE, "idle-time-heartbeat-notify");
  });

  describe("buildCompactLine", () => {
    it("renders on state with interval", () => {
      const msg = makeMessage("enabled via /idle-time-heartbeat", { enabled: true, intervalMinutes: 4.5 });
      const line = buildCompactLine(msg, plainTheme, 120);
      assert.match(line, /♥ idle heartbeat on/);
      assert.match(line, /· 4\.5m/);
    });

    it("renders off state without interval", () => {
      const msg = makeMessage("disabled", { enabled: false, intervalMinutes: 0 });
      const line = buildCompactLine(msg, plainTheme, 120);
      assert.match(line, /♥ idle heartbeat off/);
      assert.doesNotMatch(line, /· 0m/);
    });

    it("renders off state with original interval as the result detail", () => {
      const msg = makeMessage("disabled", { enabled: false, intervalMinutes: 4.5 });
      const line = buildCompactLine(msg, plainTheme, 120);
      assert.match(line, /♥ idle heartbeat off/);
      assert.doesNotMatch(line, /· 4\.5m/);
    });

    it("falls back to a generic line when details missing", () => {
      const msg = { content: "x", details: undefined };
      const line = buildCompactLine(msg, plainTheme, 120);
      assert.match(line, /♥ idle heartbeat/);
    });

    it("never exceeds the requested width", () => {
      const msg = makeMessage("x".repeat(500));
      const line = buildCompactLine(msg, plainTheme, 40);
      assert.ok(visibleWidth(line) <= 40, `line width ${visibleWidth(line)} > 40`);
    });
  });

  describe("buildExpandedComponent", () => {
    it("renders the header and source line", () => {
      const msg = makeMessage("enabled", { enabled: true, intervalMinutes: 4.5, source: "command" });
      const lines = buildExpandedComponent(msg, plainTheme).render(120);
      const joined = lines.join("\n");
      assert.match(joined, /♥ idle heartbeat on/);
      assert.match(joined, /via command/);
      assert.match(joined, /enabled/);
    });

    it("omits the body when content is empty", () => {
      const msg = makeMessage("", { enabled: false });
      const lines = buildExpandedComponent(msg, plainTheme).render(120);
      // header + meta only
      assert.equal(lines.filter((l) => l.trim().length > 0).length, 2);
    });
  });

  describe("CompactHeartbeatNotify", () => {
    it("renders one line when collapsed", () => {
      const msg = makeMessage("enabled", { enabled: true, intervalMinutes: 4.5 });
      const component = new CompactHeartbeatNotify(msg, false, plainTheme);
      const lines = component.render(120).filter((l) => l.length > 0);
      assert.equal(lines.length, 1);
    });

    it("renders multiple lines when expanded", () => {
      const msg = makeMessage("enabled", { enabled: true, intervalMinutes: 4.5, source: "command" });
      const component = new CompactHeartbeatNotify(msg, true, plainTheme);
      const lines = component.render(120).filter((l) => l.length > 0);
      assert.ok(lines.length >= 2);
    });

    it("caches the rendered output", () => {
      const msg = makeMessage("x");
      const component = new CompactHeartbeatNotify(msg, false, plainTheme);
      const a = component.render(80);
      const b = component.render(80);
      assert.deepEqual(a, b);
    });

    it("invalidates the cache", () => {
      const msg = makeMessage("x");
      const component = new CompactHeartbeatNotify(msg, false, plainTheme);
      const a = component.render(80);
      component.invalidate();
      const b = component.render(80);
      assert.deepEqual(a, b);
    });
  });
});
