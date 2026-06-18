/**
 * Per-session state persistence with atomic writes.
 *
 * Since pi extensions run in a single process, we use an in-process mutex
 * per session (promise chain) and atomic temp-file rename for disk safety.
 * No cross-process file locks needed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { sanitizeSessionId } from "./sanitize.js";

const TMP_SWEEP_MAX_AGE_MS = 60 * 60 * 1000;

export const PERSISTED_FIELDS = new Set([
  "lastUserPromptAt",
  "lastStopAt",
  "lastAssistantMessageAt",
  "lastTurnExecMs",
  "modelAtLastStop",
  "modelAtLastStopAt",
  "heartbeatEnabled",
  "heartbeatIntervalMinutes",
  "activeGoal",
  "goalCreatedAt",
  "goalIntervalMinutes",
]);

export interface SessionState {
  sessionId: string;
  lastUserPromptAt?: string | null;
  lastStopAt?: string | null;
  lastAssistantMessageAt?: string | null;
  lastTurnExecMs?: number | null;
  modelAtLastStop?: string | null;
  modelAtLastStopAt?: string | null;
  heartbeatEnabled?: boolean | null;
  heartbeatIntervalMinutes?: number | null;
  activeGoal?: string | null;
  goalCreatedAt?: string | null;
  goalIntervalMinutes?: number | null;
}

const sessionLocks = new Map<string, Promise<unknown>>();

export function getSessionFilePath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "sessions", `${sanitizeSessionId(sessionId)}.json`);
}

function pickPersisted(state: Record<string, unknown>): Partial<SessionState> {
  if (!state || typeof state !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of PERSISTED_FIELDS) {
    if (key in state) out[key] = state[key];
  }
  return out as Partial<SessionState>;
}

async function sweepStaleTmpFiles(sessionDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".tmp"))
      .map(async (name) => {
        try {
          const stat = await fs.stat(path.join(sessionDir, name));
          if (now - stat.mtimeMs > TMP_SWEEP_MAX_AGE_MS) {
            await fs.unlink(path.join(sessionDir, name));
          }
        } catch {
          // ignore
        }
      }),
  );
}

export async function loadSessionState(opts: {
  dataDir: string;
  sessionId: string;
}): Promise<SessionState> {
  const filePath = getSessionFilePath(opts.dataDir, opts.sessionId);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as SessionState;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { sessionId: opts.sessionId };
    }

    if (error instanceof SyntaxError) {
      const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(filePath, quarantinePath);
        process.stderr.write(`[idle-timing] quarantined corrupt state file: ${quarantinePath}\n`);
      } catch {
        // ignore
      }
      return { sessionId: opts.sessionId };
    }

    throw error;
  }
}

async function writeSessionStateAtomically(opts: {
  filePath: string;
  state: SessionState;
}): Promise<void> {
  const sessionDir = path.dirname(opts.filePath);
  const tempFilePath = `${opts.filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;

  await fs.mkdir(sessionDir, { recursive: true });
  await sweepStaleTmpFiles(sessionDir);

  await fs.writeFile(tempFilePath, JSON.stringify(opts.state));
  await fs.rename(tempFilePath, opts.filePath);
}

export async function saveSessionState(opts: {
  dataDir: string;
  sessionId: string;
  state: Partial<SessionState> & { sessionId?: string };
}): Promise<SessionState> {
  const filePath = getSessionFilePath(opts.dataDir, opts.sessionId);
  const nextState: SessionState = { sessionId: opts.sessionId, ...pickPersisted(opts.state) };

  await writeSessionStateAtomically({ filePath, state: nextState });
  return nextState;
}

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fn());
  sessionLocks.set(sessionId, next);
  try {
    return await next;
  } finally {
    if (sessionLocks.get(sessionId) === next) {
      sessionLocks.delete(sessionId);
    }
  }
}

export async function updateSessionState(opts: {
  dataDir: string;
  sessionId: string;
  patch: Partial<SessionState>;
}): Promise<SessionState> {
  return mutateSessionState({
    dataDir: opts.dataDir,
    sessionId: opts.sessionId,
    mutator: () => pickPersisted(opts.patch),
  });
}

export async function mutateSessionState(opts: {
  dataDir: string;
  sessionId: string;
  mutator: (existing: SessionState) => Partial<SessionState>;
}): Promise<SessionState> {
  const filePath = getSessionFilePath(opts.dataDir, opts.sessionId);

  return withSessionLock(opts.sessionId, async () => {
    const current = await loadSessionState({ dataDir: opts.dataDir, sessionId: opts.sessionId });
    const partial = opts.mutator(current);
    const next: SessionState = { ...current, ...pickPersisted(partial) };
    await writeSessionStateAtomically({ filePath, state: next });
    return next;
  });
}
