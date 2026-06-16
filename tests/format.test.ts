import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatIdleSystemMessage, formatTimingBlock } from "../src/format.js";

describe("format", () => {
  describe("formatTimingBlock", () => {
    it("first prompt includes the local_time line", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        isFirstPrompt: true,
        idleSinceLastStopMs: null,
        lastTurnExecMs: null,
      });
      assert.equal(block, ["[timing]", "local_time=2026-04-13T04:34:56+10:00", "[/timing]"].join("\n"));
    });

    it("turn 2+ includes time without key prefix", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        isFirstPrompt: false,
        idleSinceLastStopMs: 14890,
        lastTurnExecMs: 4321,
      });
      assert.equal(block, ["[timing]", "2026-04-13T04:34:56+10:00", "idle_for=14.9s", "last_turn_dur=4.3s", "[/timing]"].join("\n"));
    });

    it("default isFirstPrompt=false includes time without prefix", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        idleSinceLastStopMs: 1000,
        lastTurnExecMs: 1000,
      });
      assert.ok(block.includes("2026-04-13T04:34:56+10:00"), "should include the time");
      assert.equal(block.includes("local_time="), false, "should not have local_time= prefix");
    });

    it("uses last_turn_dur and idle_for names", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        isFirstPrompt: true,
        idleSinceLastStopMs: 14890,
        lastTurnExecMs: 4321,
      });
      assert.match(block, /last_turn_dur=4\.3s/);
      assert.match(block, /idle_for=14\.9s/);
    });

    it("omits non-finite numeric fields but keeps the block shape", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        isFirstPrompt: true,
        idleSinceLastStopMs: Number.POSITIVE_INFINITY,
        lastTurnExecMs: 4321,
      });
      assert.equal(
        block,
        ["[timing]", "local_time=2026-04-13T04:34:56+10:00", "last_turn_dur=4.3s", "[/timing]"].join("\n"),
      );
    });

    it("first prompt with no extra fields renders just the open/close tags", () => {
      const block = formatTimingBlock({
        userMessageTime: "2026-04-13T04:34:56.789+10:00",
        isFirstPrompt: true,
        idleSinceLastStopMs: null,
        lastTurnExecMs: null,
      });
      assert.equal(block, ["[timing]", "local_time=2026-04-13T04:34:56+10:00", "[/timing]"].join("\n"));
    });
  });

  describe("formatIdleSystemMessage", () => {
    it("short gaps are unaffected by config", () => {
      assert.equal(formatIdleSystemMessage(11000), "[sent after 11s]");
      assert.equal(formatIdleSystemMessage(63000), "[sent after 1m 3s]");
      assert.equal(formatIdleSystemMessage(302000), "[sent after 5m 2s]");
    });

    it("drops seconds at hour+ with default config", () => {
      assert.equal(formatIdleSystemMessage(3_600_000), "[sent after 1h 0m]");
      assert.equal(formatIdleSystemMessage(3_661_000), "[sent after 1h 1m]");
      assert.equal(formatIdleSystemMessage(7_200_000), "[sent after 2h 0m]");
    });

    it("shows days+hours at day+ with default config", () => {
      assert.equal(formatIdleSystemMessage(86_400_000), "[sent after 1d 0h]");
      assert.equal(formatIdleSystemMessage(90_000_000), "[sent after 1d 1h]");
      assert.equal(formatIdleSystemMessage(172_800_000), "[sent after 2d 0h]");
    });

    it("falls back to plain hours+minutes+seconds when formatHoursAsDays is false", () => {
      const cfg = { formatHoursAsDays: false };
      assert.equal(formatIdleSystemMessage(3_600_000, cfg), "[sent after 1h 0m 0s]");
      assert.equal(formatIdleSystemMessage(3_661_000, cfg), "[sent after 1h 1m 1s]");
      assert.equal(formatIdleSystemMessage(86_400_000, cfg), "[sent after 24h 0m 0s]");
    });

    it("respects a custom threshold", () => {
      assert.equal(formatIdleSystemMessage(5000, { idleMessageThresholdSeconds: 10 }), null);
      assert.equal(formatIdleSystemMessage(10_500, { idleMessageThresholdSeconds: 10 }), "[sent after 10s]");
    });

    it("returns null for null/NaN/Infinity", () => {
      assert.equal(formatIdleSystemMessage(null), null);
      assert.equal(formatIdleSystemMessage(Number.NaN), null);
      assert.equal(formatIdleSystemMessage(Number.POSITIVE_INFINITY), null);
      assert.equal(formatIdleSystemMessage(5000), null);
    });

    it("omits short or unavailable idle gaps", () => {
      assert.equal(formatIdleSystemMessage(10000), null);
      assert.equal(formatIdleSystemMessage(9999), null);
    });
  });
});
