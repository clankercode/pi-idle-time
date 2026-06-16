import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toIsoUtc, toLocalIso, getNowIso, stripMs, diffMs } from "../src/time.js";

describe("time", () => {
  it("toIsoUtc normalizes a date-like value to UTC ISO 8601", () => {
    assert.equal(toIsoUtc("2026-04-12T18:34:56.789Z"), "2026-04-12T18:34:56.789Z");
  });

  it("getNowIso prefers the deterministic test override", () => {
    assert.equal(
      getNowIso({ PI_IDLE_TIMING_NOW_ISO: "2026-04-12T18:34:56.789Z" } as Record<string, string | undefined>),
      "2026-04-12T18:34:56.789Z",
    );
  });

  it("diffMs returns null when either side is unavailable", () => {
    assert.equal(diffMs("2026-04-12T18:34:56.789Z", undefined), null);
    assert.equal(diffMs(undefined, "2026-04-12T18:34:56.789Z"), null);
  });

  it("diffMs returns whole millisecond deltas", () => {
    assert.equal(diffMs("2026-04-12T18:34:56.789Z", "2026-04-12T18:34:40.000Z"), 16789);
  });

  it("diffMs returns null for malformed timestamps", () => {
    assert.equal(diffMs("not-a-timestamp", "2026-04-12T18:34:40.000Z"), null);
    assert.equal(diffMs("2026-04-12T18:34:56.789Z", "not-a-timestamp"), null);
  });

  it("stripMs drops fractional seconds while preserving Z or offset suffix", () => {
    assert.equal(stripMs("2026-04-13T04:34:56.789+10:00"), "2026-04-13T04:34:56+10:00");
    assert.equal(stripMs("2026-04-13T04:34:56.789Z"), "2026-04-13T04:34:56Z");
    assert.equal(stripMs("2026-04-13T04:34:56+10:00"), "2026-04-13T04:34:56+10:00");
  });

  it("toLocalIso emits explicit offset and millisecond precision", () => {
    const fakeDate = {
      getFullYear: () => 2026,
      getMonth: () => 3,
      getDate: () => 13,
      getHours: () => 4,
      getMinutes: () => 34,
      getSeconds: () => 56,
      getMilliseconds: () => 789,
      getTimezoneOffset: () => -600,
    } as unknown as Date;
    assert.equal(toLocalIso(fakeDate), "2026-04-13T04:34:56.789+10:00");

    const negativeOffset = { ...fakeDate, getTimezoneOffset: () => 300 } as unknown as Date;
    assert.equal(toLocalIso(negativeOffset), "2026-04-13T04:34:56.789-05:00");
  });
});
