import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getSessionFilePath,
  loadSessionState,
  saveSessionState,
  updateSessionState,
  mutateSessionState,
} from "../src/state.js";

describe("state", () => {
  it("loadSessionState returns a default object when the session is new", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const state = await loadSessionState({ dataDir, sessionId: "session-1" });
    assert.deepEqual(state, { sessionId: "session-1" });
  });

  it("getSessionFilePath keeps session files inside the sessions directory", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const filePath = getSessionFilePath(dataDir, "../session-1");
    assert.equal(path.dirname(filePath), path.join(dataDir, "sessions"));
    assert.equal(filePath, path.join(dataDir, "sessions", ".._session-1.json"));
  });

  it("saveSessionState persists a session record that can be loaded again", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));

    await saveSessionState({
      dataDir,
      sessionId: "session-1",
      state: {
        lastUserPromptAt: "2026-04-12T18:34:56.789Z",
        lastTurnExecMs: 4321,
      },
    });

    const filePath = getSessionFilePath(dataDir, "session-1");
    assert.ok(fs.existsSync(filePath), "expected persisted state file to exist");

    const reloaded = await loadSessionState({ dataDir, sessionId: "session-1" });
    assert.deepEqual(reloaded, {
      sessionId: "session-1",
      lastUserPromptAt: "2026-04-12T18:34:56.789Z",
      lastTurnExecMs: 4321,
    });

    const sessionDirEntries = fs.readdirSync(path.join(dataDir, "sessions"));
    assert.deepEqual(sessionDirEntries, ["session-1.json"]);
  });

  it("concurrent saveSessionState calls do not collide on the temp file", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    const writes = Array.from({ length: 25 }, (_, i) =>
      saveSessionState({
        dataDir,
        sessionId,
        state: { lastUserPromptAt: `2026-04-12T18:34:${String(i % 60).padStart(2, "0")}.000Z` },
      }),
    );

    await assert.doesNotReject(Promise.all(writes));

    const reloaded = await loadSessionState({ dataDir, sessionId });
    assert.equal(reloaded.sessionId, "session-1");
    assert.ok(reloaded.lastUserPromptAt, "expected lastUserPromptAt to be set");

    const sessionDir = path.join(dataDir, "sessions");
    const entries = fs.readdirSync(sessionDir);
    assert.ok(
      !entries.some((entry) => entry.endsWith(".tmp")),
      `expected no leftover .tmp files, got: ${entries.join(", ")}`,
    );
  });

  it("loadSessionState quarantines a corrupt JSON file and returns a default state", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";
    const sessionDir = path.join(dataDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "session-1.json");
    fs.writeFileSync(filePath, "{ this is not valid json");

    const captured: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let state;
    try {
      state = await loadSessionState({ dataDir, sessionId });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.deepEqual(state, { sessionId: "session-1" });
    assert.ok(
      captured.some((line) => /quarantined corrupt state file/.test(line)),
      `expected a quarantine message, got: ${captured.join("")}`,
    );

    const entries = fs.readdirSync(sessionDir);
    assert.ok(!entries.includes("session-1.json"), "expected the corrupt file to be moved");
    assert.ok(
      entries.some((name) => name.startsWith("session-1.json.corrupt-")),
      `expected a .corrupt-<ts> file, got: ${entries.join(", ")}`,
    );
  });

  it("saveSessionState drops fields that are not in the persisted schema", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastUserPromptAt: "2026-04-12T18:34:56.000Z",
        lastTurnExecMs: 4321,
        sessionId: "spoofed",
        arbitrary: "should be dropped",
        cwd: "/tmp",
      } as any,
    });

    const reloaded = await loadSessionState({ dataDir, sessionId });
    assert.deepEqual(reloaded, {
      sessionId: "session-1",
      lastUserPromptAt: "2026-04-12T18:34:56.000Z",
      lastTurnExecMs: 4321,
    });
  });

  it("updateSessionState merges a patch into existing state atomically", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: {
        lastUserPromptAt: "2026-04-12T18:00:00.000Z",
        lastTurnExecMs: 1000,
      },
    });

    const next = await updateSessionState({
      dataDir,
      sessionId,
      patch: { lastStopAt: "2026-04-12T18:00:05.000Z" },
    });

    assert.deepEqual(next, {
      sessionId: "session-1",
      lastUserPromptAt: "2026-04-12T18:00:00.000Z",
      lastTurnExecMs: 1000,
      lastStopAt: "2026-04-12T18:00:05.000Z",
    });
  });

  it("concurrent updateSessionState calls preserve every patch", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    await Promise.all([
      updateSessionState({ dataDir, sessionId, patch: { lastUserPromptAt: "A" } }),
      updateSessionState({ dataDir, sessionId, patch: { lastStopAt: "B" } }),
      updateSessionState({ dataDir, sessionId, patch: { lastTurnExecMs: 4321 } }),
      updateSessionState({ dataDir, sessionId, patch: { lastAssistantMessageAt: "C" } }),
      updateSessionState({ dataDir, sessionId, patch: { modelAtLastStop: "opus-4-7" } }),
    ]);

    const reloaded = await loadSessionState({ dataDir, sessionId });
    assert.equal(reloaded.lastUserPromptAt, "A");
    assert.equal(reloaded.lastStopAt, "B");
    assert.equal(reloaded.lastTurnExecMs, 4321);
    assert.equal(reloaded.lastAssistantMessageAt, "C");
    assert.equal(reloaded.modelAtLastStop, "opus-4-7");
  });

  it("mutateSessionState runs the mutator inside the per-session lock", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: { lastUserPromptAt: "2026-04-12T18:00:00.000Z" },
    });

    let observed: unknown;
    const result = await mutateSessionState({
      dataDir,
      sessionId,
      mutator: (existing) => {
        observed = existing;
        return { lastTurnExecMs: 5000 };
      },
    });

    assert.equal((observed as { lastUserPromptAt?: string }).lastUserPromptAt, "2026-04-12T18:00:00.000Z");
    assert.equal(result.lastTurnExecMs, 5000);

    const reloaded = await loadSessionState({ dataDir, sessionId });
    assert.equal(reloaded.lastUserPromptAt, "2026-04-12T18:00:00.000Z");
    assert.equal(reloaded.lastTurnExecMs, 5000);
  });

  it("getSessionFilePath rejects empty, null, and overlong session ids", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));

    assert.throws(() => getSessionFilePath(dataDir, ""), /between 1 and/);
    assert.throws(() => getSessionFilePath(dataDir, null as unknown as string), /required/);
    assert.throws(() => getSessionFilePath(dataDir, undefined as unknown as string), /required/);
    assert.throws(() => getSessionFilePath(dataDir, "x".repeat(257)), /between 1 and 256/);
  });

  it("saveSessionState sweeps stale .tmp files older than an hour", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionDir = path.join(dataDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });

    const staleTmp = path.join(sessionDir, "session-1.json.deadbeef.tmp");
    const freshTmp = path.join(sessionDir, "session-1.json.fresh1234.tmp");
    fs.writeFileSync(staleTmp, "{}");
    fs.writeFileSync(freshTmp, "{}");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    await saveSessionState({
      dataDir,
      sessionId: "session-1",
      state: { lastUserPromptAt: "2026-04-12T18:00:00.000Z" },
    });

    const entries = fs.readdirSync(sessionDir);
    assert.ok(!entries.includes(path.basename(staleTmp)), "stale .tmp should be swept");
    assert.ok(
      entries.includes(path.basename(freshTmp)),
      `fresh .tmp should be left alone, got: ${entries.join(", ")}`,
    );
  });

  it("saveSessionState uses compact JSON, not pretty-printed", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-state-"));
    const sessionId = "session-1";

    await saveSessionState({
      dataDir,
      sessionId,
      state: { lastUserPromptAt: "2026-04-12T18:00:00.000Z" },
    });

    const filePath = getSessionFilePath(dataDir, sessionId);
    const raw = fs.readFileSync(filePath, "utf8");
    assert.ok(!raw.includes("\n  "), `expected single-line JSON, got: ${raw}`);
  });
});
