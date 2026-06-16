/**
 * Manages a flat .lastresponse file per session for fast statusline reads.
 * Contains a single ISO timestamp, no trailing newline.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { trySanitizeSessionId } from "./sanitize.js";

export function getLastResponseFilePath(dataDir: string, sessionId: string): string | null {
  const safeId = trySanitizeSessionId(sessionId);
  if (!safeId) return null;
  return path.join(dataDir, "sessions", `${safeId}.lastresponse`);
}

export async function writeLastResponse(opts: {
  dataDir: string;
  sessionId: string;
  timestamp: string;
}): Promise<void> {
  const filePath = getLastResponseFilePath(opts.dataDir, opts.sessionId);
  if (!filePath) return;
  const sessionDir = path.dirname(filePath);
  const tempFilePath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(tempFilePath, opts.timestamp);
    await fs.rename(tempFilePath, filePath);
  } catch (error: unknown) {
    process.stderr.write(
      `[idle-timing] failed to write .lastresponse for ${opts.sessionId}: ${
        error && (error as Error).message ? (error as Error).message : error
      }\n`,
    );
  }
}

export async function readLastResponse(opts: {
  dataDir: string;
  sessionId: string;
}): Promise<string | null> {
  const filePath = getLastResponseFilePath(opts.dataDir, opts.sessionId);
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!Number.isFinite(Date.parse(trimmed))) return null;
    return trimmed;
  } catch {
    return null;
  }
}
