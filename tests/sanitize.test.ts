import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSessionId, trySanitizeSessionId } from "../src/sanitize.js";

describe("sanitize", () => {
  it("sanitizeSessionId replaces non-allowed characters with underscore", () => {
    assert.equal(sanitizeSessionId("abc-123"), "abc-123");
    assert.equal(sanitizeSessionId("a b/c"), "a_b_c");
    assert.equal(sanitizeSessionId("safe.id_ok"), "safe.id_ok");
  });

  it("sanitizeSessionId throws on null/undefined/empty", () => {
    assert.throws(() => sanitizeSessionId(null), /required/);
    assert.throws(() => sanitizeSessionId(undefined), /required/);
    assert.throws(() => sanitizeSessionId(""), /between 1 and/);
  });

  it("sanitizeSessionId throws on overlong ids", () => {
    assert.throws(() => sanitizeSessionId("x".repeat(257)), /between 1 and 256/);
  });

  it("trySanitizeSessionId returns null on failure", () => {
    assert.equal(trySanitizeSessionId(null), null);
    assert.equal(trySanitizeSessionId(""), null);
    assert.equal(trySanitizeSessionId("abc-123"), "abc-123");
  });
});
