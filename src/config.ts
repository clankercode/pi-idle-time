/**
 * Config loading with validation, defaults, and caching.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Config {
  idleMessageThresholdSeconds: number;
  idleMessageDropSecondsAfterSeconds: number;
  dropSecondsAfterSeconds: number;
  formatHoursAsDays: boolean;
  idleHeartbeatMinutes: number | null;
  idleHeartbeatMessage: string;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  idleMessageThresholdSeconds: 10,
  idleMessageDropSecondsAfterSeconds: 3600,
  dropSecondsAfterSeconds: 900,
  formatHoursAsDays: true,
  idleHeartbeatMinutes: null,
  idleHeartbeatMessage:
    "[cache keepalive] {time} \u2014 disable via idle_time_heartbeat_control tool.",
});

const CONFIG_KEYS: readonly string[] = Object.freeze(Object.keys(DEFAULT_CONFIG));

const cache = new Map<string | undefined, Readonly<Config>>();

function emitWarning(message: string): void {
  try {
    process.stderr.write(`[idle-timing] config: ${message}\n`);
  } catch {
    // ignore
  }
}

function freezeConfig(config: Record<string, unknown>): Readonly<Config> {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) {
      emitWarning(`unknown key "${key}" ignored`);
      delete config[key];
    }
  }

  for (const key of CONFIG_KEYS) {
    if (typeof DEFAULT_CONFIG[key as keyof Config] === "number") {
      const value = config[key];
      if (value == null) {
        config[key] = DEFAULT_CONFIG[key as keyof Config];
      } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        emitWarning(`key "${key}" must be a non-negative finite number, using default`);
        config[key] = DEFAULT_CONFIG[key as keyof Config];
      }
    } else if (key === "idleHeartbeatMinutes") {
      if (config[key] === undefined || config[key] === null) {
        config[key] = DEFAULT_CONFIG[key];
      } else if (typeof config[key] !== "number" || !Number.isFinite(config[key]) || (config[key] as number) <= 0) {
        emitWarning(`key "${key}" must be a positive finite number or null, using default`);
        config[key] = DEFAULT_CONFIG[key];
      }
    } else if (key === "idleHeartbeatMessage") {
      if (config[key] === undefined || config[key] === null) {
        config[key] = DEFAULT_CONFIG[key];
      } else if (typeof config[key] !== "string") {
        emitWarning(`key "${key}" must be a string, using default`);
        config[key] = DEFAULT_CONFIG[key];
      }
    } else if (typeof DEFAULT_CONFIG[key as keyof Config] === "boolean") {
      if (typeof config[key] !== "boolean") {
        if (config[key] == null) {
          config[key] = DEFAULT_CONFIG[key as keyof Config];
        } else {
          emitWarning(`key "${key}" must be a boolean, using default`);
          config[key] = DEFAULT_CONFIG[key as keyof Config];
        }
      }
    } else {
      if (config[key] === undefined) {
        config[key] = DEFAULT_CONFIG[key as keyof Config];
      }
    }
  }

  return Object.freeze(config) as unknown as Readonly<Config>;
}

function readConfigFile(dataDir: string | undefined | null): Record<string, unknown> | null {
  if (!dataDir || typeof dataDir !== "string") {
    return null;
  }

  const filePath = path.join(dataDir, "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    emitWarning(`failed to read ${filePath}: ${(error as Error).message}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    emitWarning(`malformed JSON in ${filePath}: ${(error as Error).message}`);
    return null;
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitWarning(`${filePath} must contain a JSON object, using defaults`);
    return null;
  }

  return parsed as Record<string, unknown>;
}

export function loadConfig(opts?: { dataDir?: string }): Readonly<Config> {
  const dataDir = opts?.dataDir;

  if (cache.has(dataDir)) {
    return cache.get(dataDir)!;
  }

  const overrides = readConfigFile(dataDir) || {};
  const merged = freezeConfig({ ...DEFAULT_CONFIG, ...overrides });
  cache.set(dataDir, merged);
  return merged;
}

export function _resetConfigCacheForTesting(): void {
  cache.clear();
}
