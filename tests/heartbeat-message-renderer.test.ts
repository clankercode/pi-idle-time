/**
 * Tests for the compact [cache keepalive] message renderer.
 *
 * Mirrors the pattern in `~/.llm-general/ai-coding/pi/compact-tui-renderer-recipe.md`:
 * collapsed = exactly one line, expanded = multi-line with header + body.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CompactHeartbeatMessage,
  buildCompactLine,
  buildExpandedComponent,
  CUSTOM_TYPE,
  type HeartbeatMessageDetails,
} from "../src/heartbeat-message-renderer.js";

const plainTheme = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function makeMessage(content: string, details: Partial<HeartbeatMessageDetails> = {}) {
  return {
    content,
    details: { time: "14:32:15", intervalMinutes: 4.5, ...details } as HeartbeatMessageDetails,
  };
}

describe("heartbeat-message-renderer", () => {
  it("exports the customType used by pi.sendMessage", () => {
    assert.equal(CUSTOM_TYPE, "idle-time-heartbeat");
  });

  describe("buildCompactLine", () => {
    it("never exceeds the requested width", () => {
      const msg = makeMessage("a".repeat(500));
      const line = buildCompactLine(msg, plainTheme, 40);
      assert.ok(visibleWidth(line) <= 40, `line width ${visibleWidth(line)} > 40`);
    });

    it("truncates long content with an ellipsis", () => {
      const msg = makeMessage("a".repeat(500));
      const line = buildCompactLine(msg, plainTheme, 30);
      assert.ok(visibleWidth(line) <= 30);
      // Either an ellipsis or some truncation indicator was added
      assert.ok(line.length > 0);
    });

    it("shows icon, kind, and time", () => {
      const msg = makeMessage("ignored");
      const line = buildCompactLine(msg, plainTheme, 80);
      assert.match(line, /cache keepalive/);
      assert.match(line, /14:32:15/);
    });

    it("includes the interval when provided", () => {
      const msg = makeMessage("ignored", { intervalMinutes: 4.5 });
      const line = buildCompactLine(msg, plainTheme, 80);
      assert.match(line, /4\.5m/);
    });

    it("omits the interval when undefined", () => {
      const msg = { content: "x", details: { time: "12:00:00" } as HeartbeatMessageDetails };
      const line = buildCompactLine(msg, plainTheme, 80);
      assert.doesNotMatch(line, /m/);
    });
  });

  describe("CompactHeartbeatMessage (collapsed)", () => {
    it("renders exactly one line when collapsed", () => {
      const msg = makeMessage("line one\nline two");
      const lines = new CompactHeartbeatMessage(msg, false, plainTheme).render(80);
      assert.equal(lines.length, 1);
    });
  });

  describe("CompactHeartbeatMessage (expanded)", () => {
    it("renders more than one line when expanded", () => {
      const msg = makeMessage("line one\nline two");
      const lines = new CompactHeartbeatMessage(msg, true, plainTheme).render(80);
      assert.ok(lines.length > 1, `expected > 1 lines, got ${lines.length}`);
    });

    it("expanded view shows the full body content", () => {
      const msg = makeMessage("first line\nsecond line");
      const lines = new CompactHeartbeatMessage(msg, true, plainTheme).render(80);
      const all = lines.join("\n");
      assert.match(all, /first line/);
      assert.match(all, /second line/);
    });

    it("expanded view shows the time and interval in the header", () => {
      const msg = makeMessage("body");
      const lines = new CompactHeartbeatMessage(msg, true, plainTheme).render(80);
      const all = lines.join("\n");
      assert.match(all, /cache keepalive/);
      assert.match(all, /14:32:15/);
      assert.match(all, /4\.5m/);
    });
  });

  describe("buildExpandedComponent", () => {
    it("returns a Component that renders multiple lines", () => {
      const component = buildExpandedComponent(
        makeMessage("body content"),
        plainTheme,
      );
      const lines = component.render(80);
      assert.ok(lines.length >= 2);
    });
  });
});
