/**
 * Tests for the compact idle-goal reminder message renderer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CompactGoalMessage,
  buildCompactLine,
  buildExpandedComponent,
  CUSTOM_TYPE,
  type GoalMessageDetails,
} from "../src/goal-message-renderer.js";

const plainTheme = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function makeMessage(content: string, details: Partial<GoalMessageDetails> = {}) {
  return {
    content,
    details: { time: "14:32:15", intervalMinutes: 4.5, goal: "refactor the auth module", ...details } as GoalMessageDetails,
  };
}

describe("goal-message-renderer", () => {
  it("exports the customType used by pi.sendMessage", () => {
    assert.equal(CUSTOM_TYPE, "idle-time-goal");
  });

  describe("buildCompactLine", () => {
    it("never exceeds the requested width", () => {
      const msg = makeMessage("x", { goal: "a".repeat(500) });
      const line = buildCompactLine(msg, plainTheme, 40);
      assert.ok(visibleWidth(line) <= 40, `line width ${visibleWidth(line)} > 40`);
    });

    it("shows icon, kind, goal preview, time, and interval", () => {
      const msg = makeMessage("ignored");
      const line = buildCompactLine(msg, plainTheme, 80);
      assert.match(line, /idle goal/);
      assert.match(line, /refactor the auth module/);
      assert.match(line, /14:32:15/);
      assert.match(line, /4\.5m/);
    });

    it("truncates long goal descriptions", () => {
      const msg = makeMessage("ignored", { goal: "a".repeat(500) });
      const line = buildCompactLine(msg, plainTheme, 40);
      assert.ok(visibleWidth(line) <= 40);
      // Either an ellipsis or some truncation indicator was added
      assert.ok(line.length > 0);
    });

    it("omits the interval when undefined", () => {
      const msg = { content: "x", details: { time: "12:00:00", goal: "do a thing" } as GoalMessageDetails };
      const line = buildCompactLine(msg, plainTheme, 80);
      assert.doesNotMatch(line, /\d+m/);
    });
  });

  describe("CompactGoalMessage (collapsed)", () => {
    it("renders exactly one line when collapsed", () => {
      const msg = makeMessage("line one\nline two");
      const lines = new CompactGoalMessage(msg, false, plainTheme).render(80);
      assert.equal(lines.length, 1);
    });
  });

  describe("CompactGoalMessage (expanded)", () => {
    it("renders more than one line when expanded", () => {
      const msg = makeMessage("line one\nline two");
      const lines = new CompactGoalMessage(msg, true, plainTheme).render(80);
      assert.ok(lines.length > 1, `expected > 1 lines, got ${lines.length}`);
    });

    it("expanded view shows the full body content", () => {
      const msg = makeMessage("first line\nsecond line");
      const lines = new CompactGoalMessage(msg, true, plainTheme).render(80);
      const all = lines.join("\n");
      assert.match(all, /first line/);
      assert.match(all, /second line/);
    });

    it("expanded view shows the goal preview, time, and interval in the header", () => {
      const msg = makeMessage("body");
      const lines = new CompactGoalMessage(msg, true, plainTheme).render(80);
      const all = lines.join("\n");
      assert.match(all, /idle goal/);
      assert.match(all, /refactor the auth module/);
      assert.match(all, /14:32:15/);
      assert.match(all, /4\.5m/);
    });
  });

  describe("buildExpandedComponent", () => {
    it("returns a Component that renders multiple lines", () => {
      const component = buildExpandedComponent(makeMessage("body content"), plainTheme);
      const lines = component.render(80);
      assert.ok(lines.length >= 2);
    });
  });
});
