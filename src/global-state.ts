/**
 * Global state for the extension.
 *
 * Persists values that should survive session reloads (e.g.
 * `heartbeatEnabled`). Stored in `${dataDir}/global.json` with atomic writes.
 *
 * Use this for state that is not session-specific. Per-session state
 * belongs in `state.ts`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GlobalState {
  heartbeatEnabled: boolean;
}

const DEFAULT_GLOBAL_STATE: Readonly<GlobalState> = Object.freeze({
  heartbeatEnabled: false,
});

function getGlobalStatePath(dataDir: string): string {
  return path.join(dataDir, "global.json");
}

export async function loadGlobalState(dataDir: string | null | undefined): Promise<GlobalState> {
  if (!dataDir) {
    return { ...DEFAULT_GLOBAL_STATE };
  }
  const filePath = getGlobalStatePath(dataDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GlobalState>;
    return {
      heartbeatEnabled: Boolean(parsed.heartbeatEnabled),
    };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_GLOBAL_STATE };
    }
    if (error instanceof SyntaxError) {
      // Quarantine corrupt file and return defaults
      const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(filePath, quarantinePath);
        process.stderr.write(`[idle-time] quarantined corrupt global state: ${quarantinePath}\n`);
      } catch {
        // ignore
      }
      return { ...DEFAULT_GLOBAL_STATE };
    }
    throw error;
  }
}

export async function saveGlobalState(
  dataDir: string | null | undefined,
  state: Partial<GlobalState>,
): Promise<void> {
  if (!dataDir) return;
  await fs.mkdir(dataDir, { recursive: true });
  const filePath = getGlobalStatePath(dataDir);
  const next: GlobalState = {
    heartbeatEnabled:
      typeof state.heartbeatEnabled === "boolean"
        ? state.heartbeatEnabled
        : DEFAULT_GLOBAL_STATE.heartbeatEnabled,
  };
  await fs.writeFile(filePath, JSON.stringify(next), "utf8");
}
