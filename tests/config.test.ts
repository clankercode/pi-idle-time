import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, DEFAULT_CONFIG, _resetConfigCacheForTesting } from "../src/config.js";

function withTempDataDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-timing-config-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

afterEach(() => {
  _resetConfigCacheForTesting();
});

describe("config", () => {
  it("returns defaults when no dataDir is provided", () => {
    const config = loadConfig();
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("returns defaults when the config.json file does not exist", () => {
    withTempDataDir((dataDir) => {
      const config = loadConfig({ dataDir });
      assert.deepEqual(config, DEFAULT_CONFIG);
    });
  });

  it("returns frozen objects that cannot be mutated", () => {
    withTempDataDir((dataDir) => {
      const config = loadConfig({ dataDir });
      assert.equal(Object.isFrozen(config), true);
    });
  });

  it("merges overrides from disk on top of defaults", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          idleMessageThresholdSeconds: 42,
          formatHoursAsDays: false,
        }),
      );
      const config = loadConfig({ dataDir });
      assert.equal(config.idleMessageThresholdSeconds, 42);
      assert.equal(config.formatHoursAsDays, false);
      assert.equal(config.dropSecondsAfterSeconds, DEFAULT_CONFIG.dropSecondsAfterSeconds);
    });
  });

  it("warns and ignores unknown keys", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          idleMessageThresholdSeconds: 15,
          somethingMadeUp: "oops",
          anotherUnknown: 99,
        }),
      );
      const warnings = captureStderr(() => {
        const config = loadConfig({ dataDir });
        assert.equal(config.idleMessageThresholdSeconds, 15);
        assert.equal((config as Record<string, unknown>).somethingMadeUp, undefined);
        assert.equal((config as Record<string, unknown>).anotherUnknown, undefined);
      });
      assert.match(warnings, /unknown key "somethingMadeUp"/);
      assert.match(warnings, /unknown key "anotherUnknown"/);
    });
  });

  it("falls back to defaults and warns on malformed JSON", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(path.join(dataDir, "config.json"), "{ not valid json");
      const warnings = captureStderr(() => {
        const config = loadConfig({ dataDir });
        assert.deepEqual(config, DEFAULT_CONFIG);
      });
      assert.match(warnings, /malformed JSON/);
    });
  });

  it("coerces invalid numeric values to the default and warns", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          idleMessageThresholdSeconds: -5,
          idleMessageDropSecondsAfterSeconds: "nope",
          dropSecondsAfterSeconds: { not: "a number" },
        }),
      );
      const warnings = captureStderr(() => {
        const config = loadConfig({ dataDir });
        assert.equal(config.idleMessageThresholdSeconds, DEFAULT_CONFIG.idleMessageThresholdSeconds);
        assert.equal(
          config.idleMessageDropSecondsAfterSeconds,
          DEFAULT_CONFIG.idleMessageDropSecondsAfterSeconds,
        );
        assert.equal(config.dropSecondsAfterSeconds, DEFAULT_CONFIG.dropSecondsAfterSeconds);
      });
      assert.match(warnings, /"idleMessageThresholdSeconds" must be a non-negative finite number/);
    });
  });

  it("coerces invalid boolean values to the default and warns", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ formatHoursAsDays: "yes please" }));
      const warnings = captureStderr(() => {
        const config = loadConfig({ dataDir });
        assert.equal(config.formatHoursAsDays, DEFAULT_CONFIG.formatHoursAsDays);
      });
      assert.match(warnings, /"formatHoursAsDays" must be a boolean/);
    });
  });

  it("caches the merged config per dataDir", () => {
    withTempDataDir((dataDir) => {
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleMessageThresholdSeconds: 25 }));
      const first = loadConfig({ dataDir });
      assert.equal(first.idleMessageThresholdSeconds, 25);

      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ idleMessageThresholdSeconds: 99 }));
      const second = loadConfig({ dataDir });
      assert.equal(second, first, "expected cached object identity");
      assert.equal(second.idleMessageThresholdSeconds, 25);
    });
  });

  it("does not throw when dataDir is undefined or null", () => {
    assert.doesNotThrow(() => loadConfig({ dataDir: undefined }));
    assert.doesNotThrow(() => loadConfig({ dataDir: undefined }));
  });
});
