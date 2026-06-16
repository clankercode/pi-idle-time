import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLastResponseFilePath, writeLastResponse, readLastResponse } from "../src/last-response.js";

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-last-response-"));
}

describe("last-response", () => {
  it("getLastResponseFilePath places the file under sessions/ with sanitized name", () => {
    const dataDir = "/tmp/example";
    const filePath = getLastResponseFilePath(dataDir, "abc/123");
    assert.equal(filePath, path.join(dataDir, "sessions", "abc_123.lastresponse"));
  });

  it("getLastResponseFilePath preserves the safe character class", () => {
    const dataDir = "/tmp/example";
    assert.equal(
      getLastResponseFilePath(dataDir, "safe-id_1.2"),
      path.join(dataDir, "sessions", "safe-id_1.2.lastresponse"),
    );
  });

  it("writeLastResponse + readLastResponse round-trips the timestamp without a trailing newline", async () => {
    const dataDir = makeDataDir();
    const sessionId = "session-1";
    const ts = "2026-04-12T19:00:00.000Z";

    await writeLastResponse({ dataDir, sessionId, timestamp: ts });

    const filePath = getLastResponseFilePath(dataDir, sessionId)!;
    const raw = fs.readFileSync(filePath, "utf8");
    assert.equal(raw, ts, "expected exact timestamp, no trailing newline");

    assert.equal(await readLastResponse({ dataDir, sessionId }), ts);
  });

  it("writeLastResponse sanitizes the session id", async () => {
    const dataDir = makeDataDir();
    const sessionId = "../escape";
    const ts = "2026-04-12T19:00:00.000Z";

    await writeLastResponse({ dataDir, sessionId, timestamp: ts });

    const filePath = getLastResponseFilePath(dataDir, sessionId)!;
    assert.ok(filePath.startsWith(path.join(dataDir, "sessions", ".._escape.lastresponse")));
    assert.equal(fs.readFileSync(filePath, "utf8"), ts);

    const entries = fs.readdirSync(path.join(dataDir, "sessions"));
    assert.ok(!entries.some((entry) => entry.endsWith(".tmp")), `unexpected tmp: ${entries.join(", ")}`);
  });

  it("readLastResponse returns null when the file does not exist", async () => {
    const dataDir = makeDataDir();
    assert.equal(await readLastResponse({ dataDir, sessionId: "never-seen" }), null);
  });

  it("readLastResponse returns null for an empty file", async () => {
    const dataDir = makeDataDir();
    const filePath = getLastResponseFilePath(dataDir, "empty")!;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");

    assert.equal(await readLastResponse({ dataDir, sessionId: "empty" }), null);
  });

  it("readLastResponse returns null for a malformed file", async () => {
    const dataDir = makeDataDir();
    const filePath = getLastResponseFilePath(dataDir, "garbage")!;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "definitely not a timestamp");

    assert.equal(await readLastResponse({ dataDir, sessionId: "garbage" }), null);
  });

  it("writeLastResponse does not throw when the data dir cannot be created and logs a notice", async () => {
    const dataDir = makeDataDir();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.writeFileSync(dataDir, "blocking file");

    const captured: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await writeLastResponse({
        dataDir,
        sessionId: "session-x",
        timestamp: "2026-04-12T19:00:00.000Z",
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(
      captured.some((line) => /failed to write \.lastresponse/.test(line)),
      `expected a stderr notice, got: ${captured.join("")}`,
    );
  });
});
