import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logError, logInfo, getLogPath, readLog } from "../src/log.js";
import { trySanitizeSessionId } from "../src/sanitize.js";

function tempDataDir(prefix = "idle-timing-log-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("log", () => {
  it("logError creates the log dir on first call", () => {
    const dataDir = tempDataDir();
    const logDir = path.join(dataDir, "logs");
    assert.equal(fs.existsSync(logDir), false);

    logError({ dataDir, sessionId: "session-1", hook: "Test", error: new Error("boom") });

    assert.equal(fs.existsSync(logDir), true);
    assert.equal(fs.statSync(logDir).isDirectory(), true);
  });

  it("logError appends a single NDJSON line with the expected fields", () => {
    const dataDir = tempDataDir();
    const sessionId = "session-1";

    logError({ dataDir, sessionId, hook: "UserPromptSubmit", error: new Error("explosion"), context: { foo: "bar" } });

    const filePath = getLogPath({ dataDir, sessionId })!;
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.hook, "UserPromptSubmit");
    assert.equal(entry.sessionId, sessionId);
    assert.equal(entry.level, "error");
    assert.equal(entry.message, "explosion");
    assert.ok(typeof entry.ts === "string" && entry.ts.length > 0);
    assert.ok(typeof entry.stack === "string" && entry.stack.includes("explosion"));
    assert.deepEqual(entry.context, { foo: "bar" });
  });

  it("logError appends additional entries on subsequent calls without overwriting", () => {
    const dataDir = tempDataDir();
    const sessionId = "session-1";

    logError({ dataDir, sessionId, hook: "A", error: new Error("first") });
    logError({ dataDir, sessionId, hook: "B", error: new Error("second") });

    const filePath = getLogPath({ dataDir, sessionId })!;
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.message, "first");
    assert.equal(second.message, "second");
    assert.equal(first.hook, "A");
    assert.equal(second.hook, "B");
  });

  it("logError does not throw on missing dataDir or missing sessionId", () => {
    const dataDir = tempDataDir();

    assert.doesNotThrow(() => logError({ dataDir: null, sessionId: "s", error: new Error("x") }));
    assert.doesNotThrow(() => logError({ dataDir, sessionId: null, error: new Error("x") }));
    assert.doesNotThrow(() => logError({ dataDir, sessionId: "", error: new Error("x") }));
    assert.doesNotThrow(() => logError({ error: new Error("x") }));
    assert.doesNotThrow(() => logError({ dataDir, sessionId: undefined, error: new Error("x") }));
    assert.doesNotThrow(() => logError({ dataDir: undefined, sessionId: "s", error: new Error("x") }));

    assert.equal(fs.existsSync(path.join(dataDir, "logs")), false);
  });

  it("logInfo writes a level=info entry without an error stack", () => {
    const dataDir = tempDataDir();
    logInfo({ dataDir, sessionId: "session-1", hook: "reset", message: "state reset" });

    const filePath = getLogPath({ dataDir, sessionId: "session-1" })!;
    const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(entry.level, "info");
    assert.equal(entry.hook, "reset");
    assert.equal(entry.message, "state reset");
    assert.equal(entry.stack, null);
  });

  it("readLog returns [] for a missing log file", async () => {
    const dataDir = tempDataDir();
    const result = await readLog({ dataDir, sessionId: "never-seen" });
    assert.deepEqual(result, []);
  });

  it("readLog returns the last N lines as parsed objects", async () => {
    const dataDir = tempDataDir();
    const sessionId = "session-1";

    for (let i = 0; i < 5; i++) {
      logInfo({ dataDir, sessionId, hook: "test", message: `entry ${i}` });
    }

    const limited = await readLog({ dataDir, sessionId, limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0].message, "entry 3");
    assert.equal(limited[1].message, "entry 4");

    const defaultLimit = await readLog({ dataDir, sessionId });
    assert.equal(defaultLimit.length, 5);
  });

  it("sanitization: sessionId with ../ writes to a sanitized log file", () => {
    const dataDir = tempDataDir();
    const dangerous = "../etc/evil";

    logError({ dataDir, sessionId: dangerous, error: new Error("x") });

    const logsDir = path.join(dataDir, "logs");
    const entries = fs.readdirSync(logsDir);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith(".log"));
    assert.ok(!entries[0].includes("/"), `sanitized entry should not contain '/', got: ${entries[0]}`);

    const filePath = path.join(logsDir, entries[0]);
    const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(entry.sessionId, trySanitizeSessionId(dangerous));
    assert.equal(entry.message, "x");
  });

  it("getLogPath returns null for missing inputs", () => {
    assert.equal(getLogPath({ dataDir: null, sessionId: "s" }), null);
    assert.equal(getLogPath({ dataDir: "/tmp", sessionId: null }), null);
    assert.equal(getLogPath({ dataDir: "/tmp", sessionId: "" }), null);
  });
});
