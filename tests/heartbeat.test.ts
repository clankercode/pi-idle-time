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
    assert.equal(timer.formatMessage("2026-06-16T21:00:00+10:00"), "keepalive 2026-06-16T21:00:00+10:00");
  });

  it("formats message with current time placeholder", () => {
    const timer = createTimer(4.5, "cache keepalive — {time}");
    assert.equal(
      timer.formatMessage("2026-06-16T21:00:00.000+10:00"),
      "cache keepalive — 2026-06-16T21:00:00+10:00",
    );
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
