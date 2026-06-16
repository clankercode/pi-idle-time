import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed } from "../src/duration.js";

const DEFAULT_OPTS = { dropSecondsAfterSeconds: 900 };

describe("duration", () => {
  it("formatElapsed returns null for null or non-finite input", () => {
    assert.equal(formatElapsed(null, DEFAULT_OPTS), null);
    assert.equal(formatElapsed(undefined, DEFAULT_OPTS), null);
    assert.equal(formatElapsed(Number.NaN, DEFAULT_OPTS), null);
    assert.equal(formatElapsed(Number.POSITIVE_INFINITY, DEFAULT_OPTS), null);
  });

  it("formatElapsed returns null for negative elapsed (clock skew)", () => {
    assert.equal(formatElapsed(-1, DEFAULT_OPTS), null);
  });

  it("formatElapsed under 60 seconds shows seconds only", () => {
    assert.equal(formatElapsed(0, DEFAULT_OPTS), "0s");
    assert.equal(formatElapsed(999, DEFAULT_OPTS), "0s");
    assert.equal(formatElapsed(1000, DEFAULT_OPTS), "1s");
    assert.equal(formatElapsed(45_000, DEFAULT_OPTS), "45s");
    assert.equal(formatElapsed(59_999, DEFAULT_OPTS), "59s");
  });

  it("formatElapsed between 60s and drop-seconds-after shows minutes and seconds", () => {
    assert.equal(formatElapsed(60_000, DEFAULT_OPTS), "1m0s");
    assert.equal(formatElapsed(201_500, DEFAULT_OPTS), "3m21s");
    assert.equal(formatElapsed(899_000, DEFAULT_OPTS), "14m59s");
  });

  it("formatElapsed at or above drop-seconds-after under an hour drops seconds", () => {
    assert.equal(formatElapsed(900_000, DEFAULT_OPTS), "15m");
    assert.equal(formatElapsed(1_020_000, DEFAULT_OPTS), "17m");
    assert.equal(formatElapsed(3_599_000, DEFAULT_OPTS), "59m");
  });

  it("formatElapsed at or above one hour shows hours and minutes only", () => {
    assert.equal(formatElapsed(3_600_000, DEFAULT_OPTS), "1h0m");
    assert.equal(formatElapsed(5_000_000, DEFAULT_OPTS), "1h23m");
    assert.equal(formatElapsed(36_060_000, DEFAULT_OPTS), "10h1m");
  });

  it("formatElapsed at or above one day shows days and hours", () => {
    assert.equal(formatElapsed(86_400_000, DEFAULT_OPTS), "1d0h");
    assert.equal(formatElapsed(90_000_000, DEFAULT_OPTS), "1d1h");
    assert.equal(formatElapsed(172_800_000, DEFAULT_OPTS), "2d0h");
    assert.equal(formatElapsed(100_800_000, DEFAULT_OPTS), "1d4h");
  });

  it("formatElapsed honors a custom dropSecondsAfterSeconds threshold", () => {
    assert.equal(formatElapsed(30_000, { dropSecondsAfterSeconds: 10 }), "30s");
    assert.equal(formatElapsed(60_000, { dropSecondsAfterSeconds: 30 }), "1m");
    assert.equal(formatElapsed(120_000, { dropSecondsAfterSeconds: 30 }), "2m");
  });
});
