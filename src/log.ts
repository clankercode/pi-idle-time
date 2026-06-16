/**
 * Per-session NDJSON error logger with atomic appends.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { trySanitizeSessionId } from "./sanitize.js";

export function getLogPath(opts: { dataDir?: string | null; sessionId?: string | null }): string | null {
  if (!opts.dataDir || !opts.sessionId) return null;
  const safe = trySanitizeSessionId(opts.sessionId);
  if (!safe) return null;
  return path.join(opts.dataDir, "logs", `${safe}.log`);
}

function ensureLogDirSync(logDir: string): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // ignore
  }
}

function appendEntry(entry: {
  dataDir?: string | null;
  sessionId?: string | null;
  hook?: string | null;
  level: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
}): void {
  if (!entry.dataDir || !entry.sessionId) return;
  const safeId = trySanitizeSessionId(entry.sessionId);
  if (!safeId) return;
  const logDir = path.join(entry.dataDir, "logs");
  ensureLogDirSync(logDir);
  const filePath = path.join(logDir, `${safeId}.log`);
  const record = {
    ts: new Date().toISOString(),
    hook: entry.hook || null,
    sessionId: safeId,
    level: entry.level,
    message: entry.message,
    stack: entry.stack || null,
    context: entry.context || null,
  };
  let line: string;
  try {
    line = JSON.stringify(record) + "\n";
  } catch {
    return;
  }
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    // file doesn't exist yet
  }
  const next = existing + line;
  const tempPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, next);
    fs.renameSync(tempPath, filePath);
  } catch {
    // best-effort
  }
}

export function logError(opts: {
  dataDir?: string | null;
  sessionId?: string | null;
  hook?: string | null;
  error: Error | unknown;
  context?: Record<string, unknown> | null;
}): void {
  appendEntry({
    dataDir: opts.dataDir,
    sessionId: opts.sessionId,
    hook: opts.hook,
    level: "error",
    message: opts.error instanceof Error ? opts.error.message : opts.error ? String(opts.error) : "unknown error",
    stack: opts.error instanceof Error ? opts.error.stack || null : null,
    context: opts.context,
  });
}

export function logInfo(opts: {
  dataDir?: string | null;
  sessionId?: string | null;
  hook?: string | null;
  message?: string;
  context?: Record<string, unknown> | null;
}): void {
  appendEntry({
    dataDir: opts.dataDir,
    sessionId: opts.sessionId,
    hook: opts.hook,
    level: "info",
    message: opts.message || "info",
    context: opts.context,
  });
}

export async function readLog(opts: {
  dataDir?: string | null;
  sessionId?: string | null;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const filePath = getLogPath({ dataDir: opts.dataDir, sessionId: opts.sessionId });
  if (!filePath) return [];
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const limit = opts.limit ?? 50;
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n").filter((l) => l.length > 0).slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
