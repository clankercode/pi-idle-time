/**
 * Tests for the idle goal reminder formatter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatGoalMessage } from "../src/goal.js";

describe("goal", () => {
  it("formats a goal reminder with the exact LLM-facing structure", () => {
    const goal = "refactor the auth module";
    const time = "19:46:13";
    const message = formatGoalMessage(goal, time);

    assert.equal(
      message,
      `[goal reminder] ${time}\n${goal}\n\n<system-reminder>Use idle_time_heartbeat_control with completeGoal=true only when the underlying task is actually finished. Idle does not mean done, and receiving this reminder does not mean the goal is complete. If work is still in progress, leave the goal active and continue working or send a status update.</system-reminder>`,
    );
  });

  it("preserves multi-word goal descriptions on their own line", () => {
    const goal = "write tests for the new parser";
    const message = formatGoalMessage(goal, "09:15:42");

    const lines = message.split("\n");
    assert.equal(lines[0], "[goal reminder] 09:15:42");
    assert.equal(lines[1], goal);
    assert.ok(lines[lines.length - 1].includes("completeGoal=true"));
  });

  it("does not instruct the model to reply to the reminder", () => {
    const message = formatGoalMessage("do a thing", "12:00:00");
    assert.doesNotMatch(message, /reply/);
    assert.doesNotMatch(message, /respond/);
    assert.doesNotMatch(message, /acknowledge/);
  });

  it("names the correct tool for completing the goal", () => {
    const message = formatGoalMessage("do a thing", "12:00:00");
    assert.match(message, /idle_time_heartbeat_control/);
    assert.match(message, /completeGoal=true/);
  });

  it("makes clear that idle is not the same as done", () => {
    const message = formatGoalMessage("do a thing", "12:00:00");
    assert.match(message, /Idle does not mean done/i);
    assert.match(message, /receiving this reminder does not mean the goal is complete/i);
    assert.match(message, /continue working or send a status update/i);
  });
});
