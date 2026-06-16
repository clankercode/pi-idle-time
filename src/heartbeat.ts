/**
 * Idle heartbeat timer.
 *
 * Sends a keepalive user message after a configurable period of inactivity
 * to keep the Anthropic prompt cache warm. The timer is fake-clock-friendly
 * for testing.
 */

import { diffMs, getNowIso, stripMs } from "./time.js";

export interface HeartbeatOptions {
  /** Interval in minutes. Must be positive. */
  intervalMinutes: number;
  /** Message template; {time} is replaced with current local time to the second. */
  messageTemplate: string;
  /** Called when the heartbeat fires. */
  onFire: () => void;
  /** Clock source; defaults to getNowIso(). */
  now?: () => string;
  /** Timer scheduler; defaults to global setTimeout/clearTimeout. */
  scheduler?: TimerScheduler;
}

export interface TimerScheduler {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  readonly id: unknown;
}


function toNativeHandle(handle: TimerHandle): ReturnType<typeof setTimeout> {
  return (handle as unknown as { native: ReturnType<typeof setTimeout> }).native;
}

const DEFAULT_SCHEDULER: TimerScheduler = {
  setTimeout: (callback, ms) => {
    const native = setTimeout(callback, ms);
    return { native } as unknown as TimerHandle;
  },
  clearTimeout: (handle) => clearTimeout(toNativeHandle(handle)),
};

export class HeartbeatTimer {
  private intervalMinutes: number;
  private messageTemplate: string;
  private onFire: () => void;
  private now: () => string;
  private scheduler: TimerScheduler;
  private handle: TimerHandle | null = null;
  private lastResponseAt: string | null = null;

  constructor(opts: HeartbeatOptions) {
    if (!Number.isFinite(opts.intervalMinutes) || opts.intervalMinutes <= 0) {
      throw new TypeError("intervalMinutes must be a positive finite number");
    }
    this.intervalMinutes = opts.intervalMinutes;
    this.messageTemplate = opts.messageTemplate;
    this.onFire = opts.onFire;
    this.now = opts.now ?? getNowIso;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Replace the active interval/message without stopping the timer. */
  configure(opts: { intervalMinutes?: number; messageTemplate?: string }): void {
    if (opts.intervalMinutes !== undefined) {
      if (!Number.isFinite(opts.intervalMinutes) || opts.intervalMinutes <= 0) {
        throw new TypeError("intervalMinutes must be a positive finite number");
      }
      this.intervalMinutes = opts.intervalMinutes;
    }
    if (opts.messageTemplate !== undefined) {
      this.messageTemplate = opts.messageTemplate;
    }
    this.reschedule();
  }

  /** Arm or re-arm the heartbeat from the given last-response timestamp. */
  start(lastResponseAt: string | null): void {
    this.lastResponseAt = lastResponseAt;
    this.reschedule();
  }

  /** Stop the timer. */
  stop(): void {
    if (this.handle) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
  }

  /** Update the reference time and reschedule. */
  reset(lastResponseAt: string | null): void {
    this.lastResponseAt = lastResponseAt;
    this.reschedule();
  }

  /** Whether the timer is currently armed. */
  get isRunning(): boolean {
    return this.handle !== null;
  }

  /** Current configured interval in minutes. */
  get interval(): number {
    return this.intervalMinutes;
  }

  /** Format a heartbeat message for the current time. */
  formatMessage(nowIso?: string): string {
    const time = this.formatCompactTime(nowIso);
    return this.messageTemplate.replaceAll("{time}", time);
  }

  /**
   * Format the current time as a compact `HH:MM:SS` local time string.
   *
   * Used by the default keepalive message — the LLM doesn't need the full ISO
   * timestamp or timezone offset, just enough to acknowledge the keepalive.
   * No padding/whitespace; always 8 characters.
   */
  formatCompactTime(nowIso?: string): string {
    const iso = nowIso ?? this.now();
    // Extract HH:MM:SS from the local ISO string.
    // `toLocalIso` produces `YYYY-MM-DDTHH:MM:SS.sss±HH:MM`.
    // We want the `HH:MM:SS` portion — index 11..19 (after the `T`).
    const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : iso;
  }

  private fireScheduled: boolean = false;

  private reschedule(): void {
    this.stop();
    if (!this.lastResponseAt) return;

    const elapsedMs = diffMs(this.now(), this.lastResponseAt);
    if (elapsedMs === null) return;

    const intervalMs = this.intervalMinutes * 60 * 1000;
    const remainingMs = intervalMs - elapsedMs;

    if (remainingMs <= 0) {
      // Already past due — fire at next tick so the synchronous caller can finish first.
      this.fireScheduled = true;
      this.handle = this.scheduler.setTimeout(() => this.fire(), 0);
    } else {
      this.handle = this.scheduler.setTimeout(() => this.fire(), remainingMs);
    }
  }

  private fire(): void {
    this.handle = null;
    this.onFire();
  }
}

/** Convert minutes to milliseconds. */
export function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}
