/**
 * Tests for the idle heartbeat timer.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HeartbeatTimer, minutesToMs, type TimerHandle, type TimerScheduler } from "../src/heartbeat.js";

interface FakeTimeout {
  callback: () => void;
  dueAt: number;
}

class FakeScheduler implements TimerScheduler {
  public now = 0;
  public timers: FakeTimeout[] = [];

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = { id: Symbol("fake"), callback, dueAt: this.now + ms };
    this.timers.push(handle);
    this.timers.sort((a, b) => a.dueAt - b.dueAt);
    return handle as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle) {
    this.timers = this.timers.filter((t) => t !== (handle as unknown as FakeTimeout));
  }

  advance(ms: number) {
    this.now += ms;
    const due = this.timers.filter((t) => t.dueAt <= this.now);
    this.timers = this.timers.filter((t) => t.dueAt > this.now);
    for (const t of due) {
      t.callback();
    }
  }

  nextDueAt(): number | undefined {
    return this.timers[0]?.dueAt;
  }
}

describe("heartbeat", () => {
  let fired: number;
  let scheduler: FakeScheduler;

  beforeEach(() => {
    fired = 0;
    scheduler = new FakeScheduler();
  });

  function createTimer(
    intervalMinutes: number,
    messageTemplate = "keepalive {time}",
    nowFactory?: () => string,
  ): HeartbeatTimer {
    return new HeartbeatTimer({
      intervalMinutes,
      messageTemplate,
      onFire: () => fired++,
      now: nowFactory ?? (() => new Date(scheduler.now).toISOString()),
      scheduler,
    });
  }

  it("fires after the configured interval", () => {
    const startMs = 0;
    const startIso = new Date(startMs).toISOString();
    const timer = createTimer(4.5);

    timer.start(startIso);
    assert.equal(scheduler.nextDueAt(), startMs + minutesToMs(4.5));

    scheduler.advance(minutesToMs(4.5) - 1);
    assert.equal(fired, 0);

    scheduler.advance(1);
    assert.equal(fired, 1);
    assert.equal(timer.isRunning, false);
  });

  it("fires immediately when the interval has already elapsed", () => {
    const startMs = 0;
    const startIso = new Date(startMs).toISOString();
    const timer = createTimer(4.5, "keepalive {time}", () => new Date(scheduler.now).toISOString());

    scheduler.now = minutesToMs(5);
    timer.start(startIso);
    scheduler.advance(0);
    assert.equal(fired, 1);
  });

  it("stops and does not fire", () => {
    const timer = createTimer(4.5);
    timer.start(new Date(0).toISOString());
    timer.stop();
    scheduler.advance(minutesToMs(10));
    assert.equal(fired, 0);
    assert.equal(timer.isRunning, false);
  });

  it("resets the deadline when the last response time advances", () => {
    const timer = createTimer(4.5);
    timer.start(new Date(0).toISOString());
    assert.equal(scheduler.nextDueAt(), minutesToMs(4.5));

    const newResponseMs = minutesToMs(2);
    timer.reset(new Date(newResponseMs).toISOString());
    assert.equal(scheduler.nextDueAt(), newResponseMs + minutesToMs(4.5));

    scheduler.advance(minutesToMs(4.5) - 1);
    assert.equal(fired, 0);

    scheduler.advance(minutesToMs(2) + 1);
    assert.equal(fired, 1);
  });

  it("configure updates interval and message without restarting", () => {
    const timer = createTimer(4.5);
    timer.start(new Date(0).toISOString());
    assert.equal(scheduler.nextDueAt(), minutesToMs(4.5));

    timer.configure({ intervalMinutes: 2 });
    assert.equal(timer.interval, 2);
    assert.equal(scheduler.nextDueAt(), minutesToMs(2));

    scheduler.advance(minutesToMs(2));
    assert.equal(fired, 1);
    assert.equal(timer.formatMessage("2026-06-16T21:00:00+10:00"), "keepalive 21:00:00");
  });

  it("formats message with current time placeholder", () => {
    const timer = createTimer(4.5, "cache keepalive — {time}");
    assert.equal(
      timer.formatMessage("2026-06-16T21:00:00.000+10:00"),
      "cache keepalive — 21:00:00",
    );
  });

  it("formatCompactTime returns HH:MM:SS (no date, no offset)", () => {
    const timer = createTimer(4.5);
    assert.equal(
      timer.formatCompactTime("2026-06-16T21:00:00.000+10:00"),
      "21:00:00",
    );
    assert.equal(
      timer.formatCompactTime("2026-06-16T09:15:42.123+10:00"),
      "09:15:42",
    );
  });

  it("formatCompactTime does not include the date or timezone offset", () => {
    const timer = createTimer(4.5);
    const compact = timer.formatCompactTime("2026-06-16T21:00:00.000+10:00");
    assert.doesNotMatch(compact, /2026-06-16/);
    assert.doesNotMatch(compact, /\+10:00/);
    assert.equal(compact.length, "HH:MM:SS".length, "must be exactly HH:MM:SS");
  });

  it("formatMessage uses compact HH:MM:SS in the default plugin-tagged template", () => {
    // The default template includes a plugin tag + brief instruction.
    const timer = createTimer(4.5, "[idle-time heartbeat] {time} — plugin keepalive; reply with a single short acknowledgement line, no tool calls.");
    const message = timer.formatMessage("2026-06-16T21:00:00.000+10:00");
    assert.match(message, /^\[idle-time heartbeat\] 21:00:00/);
    assert.match(message, /no tool calls/);
    assert.doesNotMatch(message, /2026-06-16/);
    assert.doesNotMatch(message, /\+10:00/);
  });

  it("throws for non-positive interval", () => {
    assert.throws(() => createTimer(0), /intervalMinutes must be a positive finite number/);
    assert.throws(() => createTimer(-1), /intervalMinutes must be a positive finite number/);
  });

  it("configure throws for invalid interval", () => {
    const timer = createTimer(4.5);
    assert.throws(() => timer.configure({ intervalMinutes: 0 }), /intervalMinutes must be a positive finite number/);
  });
});
