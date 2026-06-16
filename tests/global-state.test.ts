/**
 * Tests for the global state file.
 *
 * Verifies that `heartbeatEnabled` is read from and written to a global
 * file, so it survives session reloads.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGlobalState, saveGlobalState } from "../src/global-state.js";

describe("global-state", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-time-global-"));
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns defaults when no dataDir is provided", async () => {
    const state = await loadGlobalState(null);
    assert.equal(state.heartbeatEnabled, false);
  });

  it("returns defaults when the file does not exist", async () => {
    const state = await loadGlobalState(path.join(tmpDir, "nonexistent"));
    assert.equal(state.heartbeatEnabled, false);
  });

  it("returns saved heartbeatEnabled", async () => {
    const dataDir = path.join(tmpDir, "save-read");
    await saveGlobalState(dataDir, { heartbeatEnabled: true });
    const state = await loadGlobalState(dataDir);
    assert.equal(state.heartbeatEnabled, true);
  });

  it("persists across separate load calls", async () => {
    const dataDir = path.join(tmpDir, "persist");
    await saveGlobalState(dataDir, { heartbeatEnabled: true });
    const a = await loadGlobalState(dataDir);
    const b = await loadGlobalState(dataDir);
    assert.equal(a.heartbeatEnabled, true);
    assert.equal(b.heartbeatEnabled, true);
  });

  it("can be disabled and re-enabled", async () => {
    const dataDir = path.join(tmpDir, "toggle");
    await saveGlobalState(dataDir, { heartbeatEnabled: true });
    assert.equal((await loadGlobalState(dataDir)).heartbeatEnabled, true);
    await saveGlobalState(dataDir, { heartbeatEnabled: false });
    assert.equal((await loadGlobalState(dataDir)).heartbeatEnabled, false);
  });

  it("creates the data dir if it does not exist", async () => {
    const dataDir = path.join(tmpDir, "newdir", "subdir");
    await saveGlobalState(dataDir, { heartbeatEnabled: true });
    const state = await loadGlobalState(dataDir);
    assert.equal(state.heartbeatEnabled, true);
  });

  it("quarantines a corrupt file and returns defaults", async () => {
    const dataDir = path.join(tmpDir, "corrupt");
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, "global.json");
    fs.writeFileSync(filePath, "{ not json", "utf8");

    const state = await loadGlobalState(dataDir);
    assert.equal(state.heartbeatEnabled, false);

    // Verify the file was quarantined
    const entries = fs.readdirSync(dataDir);
    assert.ok(entries.some((name) => name.startsWith("global.json.corrupt-")));
  });
});
