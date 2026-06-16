/**
 * Session ID sanitization to prevent path traversal.
 */

const SESSION_ID_MAX_LENGTH = 256;
const SANITIZE_RE = /[^A-Za-z0-9._-]/g;

export function sanitizeSessionId(sessionId: string | null | undefined): string {
  if (sessionId == null) {
    throw new TypeError("sessionId is required");
  }
  const stringId = String(sessionId);
  if (stringId.length === 0 || stringId.length > SESSION_ID_MAX_LENGTH) {
    throw new RangeError(`sessionId must be between 1 and ${SESSION_ID_MAX_LENGTH} characters`);
  }
  return stringId.replace(SANITIZE_RE, "_");
}

export function trySanitizeSessionId(sessionId: string | null | undefined): string | null {
  try {
    return sanitizeSessionId(sessionId);
  } catch {
    return null;
  }
}
