import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatStatusline, type StatuslineState } from "../src/statusline.js";

const DEFAULT_OPTS = { dropSecondsAfterSeconds: 900 };

function state(overrides: Partial<StatuslineState> = {}): StatuslineState {
  return {
    isAgentActive: false,
    turnStartAt: null,
    turnDurationFrozen: null,
    lastStopAt: null,
    lastAssistantMessageAt: null,
    currentModelId: null,
    modelAtLastStop: null,
    modelAtLastStopAt: null,
    ...overrides,
  };
}

describe("statusline", () => {
  describe("agent active", () => {
    it("shows turn duration counting up", () => {
      const result = formatStatusline(
        state({
          isAgentActive: true,
          turnStartAt: "2026-06-16T15:00:00.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:00:33.000Z",
      );
      assert.equal(result, "33s");
    });

    it("shows larger turn durations", () => {
      const result = formatStatusline(
        state({
          isAgentActive: true,
          turnStartAt: "2026-06-16T15:00:00.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:02:15.000Z",
      );
      assert.equal(result, "2m15s");
    });

    it("returns undefined when no turnStartAt", () => {
      const result = formatStatusline(
        state({ isAgentActive: true, turnStartAt: null }),
        DEFAULT_OPTS,
        "2026-06-16T15:00:33.000Z",
      );
      assert.equal(result, undefined);
    });
  });

  describe("just stopped, idle < 1s", () => {
    it("shows turn duration with idle indicator, no timer", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "40s",
          lastStopAt: "2026-06-16T15:00:40.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:40.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:00:40.500Z",
      );
      assert.equal(result, "40s|💤");
    });

    it("shows turn + idle indicator at exactly 0s idle", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "1m5s",
          lastStopAt: "2026-06-16T15:01:05.000Z",
          lastAssistantMessageAt: "2026-06-16T15:01:05.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:01:05.000Z",
      );
      assert.equal(result, "1m5s|💤");
    });
  });

  describe("idle >= 1s", () => {
    it("shows turn duration with idle timer", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "40s",
          lastStopAt: "2026-06-16T15:00:40.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:40.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:02:52.000Z",
      );
      assert.equal(result, "40s|💤2m12s");
    });

    it("shows only idle timer when no turn duration", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: null,
          lastStopAt: "2026-06-16T15:00:00.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:00.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:03:02.000Z",
      );
      assert.equal(result, "💤3m2s");
    });
  });

  describe("model change", () => {
    it("shows --- when model changed since last stop", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "40s",
          lastStopAt: "2026-06-16T15:00:40.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:40.000Z",
          currentModelId: "claude-opus-4-7",
          modelAtLastStop: "claude-sonnet-4-6",
          modelAtLastStopAt: "2026-06-16T15:00:40.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:01:10.000Z",
      );
      assert.equal(result, "40s | ---");
    });

    it("shows --- without turn prefix when no turn duration", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: null,
          lastStopAt: "2026-06-16T15:00:40.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:40.000Z",
          currentModelId: "claude-opus-4-7",
          modelAtLastStop: "claude-sonnet-4-6",
          modelAtLastStopAt: "2026-06-16T15:00:40.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:01:10.000Z",
      );
      assert.equal(result, "---");
    });

    it("does not show --- when model matches", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "40s",
          lastStopAt: "2026-06-16T15:00:40.000Z",
          lastAssistantMessageAt: "2026-06-16T15:00:40.000Z",
          currentModelId: "claude-sonnet-4-6",
          modelAtLastStop: "claude-sonnet-4-6",
          modelAtLastStopAt: "2026-06-16T15:00:40.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:02:52.000Z",
      );
      assert.equal(result, "40s|💤2m12s");
    });
  });

  describe("edge cases", () => {
    it("returns undefined when no state at all", () => {
      const result = formatStatusline(state(), DEFAULT_OPTS, "2026-06-16T15:00:00.000Z");
      assert.equal(result, undefined);
    });

    it("uses lastAssistantMessageAt when lastStopAt is null", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          lastStopAt: null,
          lastAssistantMessageAt: "2026-06-16T15:00:00.000Z",
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:02:00.000Z",
      );
      assert.equal(result, "💤2m0s");
    });

    it("handles frozen turn without idle (session just started)", () => {
      const result = formatStatusline(
        state({
          isAgentActive: false,
          turnDurationFrozen: "5s",
          lastStopAt: null,
          lastAssistantMessageAt: null,
        }),
        DEFAULT_OPTS,
        "2026-06-16T15:00:05.000Z",
      );
      assert.equal(result, "5s");
    });
  });
});
