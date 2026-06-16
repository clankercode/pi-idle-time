/**
 * Tests for the heartbeat tool renderer.
 *
 * Verifies that the call + result collapse to a single visible content line
 * in the TUI (matching pi-monitor's pattern of suppressing the call slot when
 * the result line already conveys the state).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  renderHeartbeatCall,
  renderHeartbeatResult,
  type HeartbeatCallArgs,
  type HeartbeatResultDetails,
} from "../src/heartbeat-tool-renderer.js";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function collectLines(component: Component, width = 200): string[] {
  return component.render(width);
}

function joinLines(component: Component, width = 200): string {
  return collectLines(component, width).join("\n");
}

function wrapInContainer(children: Component[]): Container {
  const c = new Container();
  for (const child of children) c.addChild(child);
  return c;
}

describe("heartbeat-tool-renderer", () => {
  describe("renderHeartbeatCall", () => {
    it("renders zero lines (call is suppressed — result conveys state)", () => {
      const component = renderHeartbeatCall({ enabled: true } as HeartbeatCallArgs, plainTheme);
      const lines = collectLines(component);
      assert.equal(lines.length, 0, "call slot must produce no visible content");
    });
  });

  describe("renderHeartbeatResult", () => {
    it("renders exactly one line when enabled", () => {
      const component = renderHeartbeatResult(
        { enabled: true, intervalMinutes: 4.5 } as HeartbeatResultDetails,
        false,
        false,
        plainTheme,
      );
      const lines = collectLines(component);
      assert.equal(lines.length, 1, "result must produce exactly one line");
      assert.match(lines[0], /♥/);
      assert.match(lines[0], /idle heartbeat on/);
      assert.match(lines[0], /4\.5m/);
    });

    it("renders exactly one line when disabled", () => {
      const component = renderHeartbeatResult(
        { enabled: false, intervalMinutes: 4.5 } as HeartbeatResultDetails,
        false,
        false,
        plainTheme,
      );
      const lines = collectLines(component);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /off/);
    });
  });

  describe("combined call + result", () => {
    it("renders to a single content line (the result) plus call-suppression", () => {
      // Simulate what ToolExecutionComponent does: wrap both in a Container.
      // With renderCall suppressed, only the result's single line should appear.
      const call = renderHeartbeatCall({ enabled: true } as HeartbeatCallArgs, plainTheme);
      const result = renderHeartbeatResult(
        { enabled: true, intervalMinutes: 4.5 } as HeartbeatResultDetails,
        false,
        false,
        plainTheme,
      );

      const wrapped = wrapInContainer([call, result]);
      const lines = collectLines(wrapped);
      assert.equal(lines.length, 1, "call+result should produce exactly one content line");
      assert.match(lines[0], /♥ idle heartbeat on · 4\.5m/);
    });

    it("matches the recommended pi-monitor pattern (renderMonitorListCall returns empty Text)", () => {
      // Sanity check: the empty-Text pattern is officially supported.
      const call = renderHeartbeatCall({ enabled: true } as HeartbeatCallArgs, plainTheme);
      assert.ok(call instanceof Text);
      assert.equal(joinLines(call), "");
    });
  });
});
