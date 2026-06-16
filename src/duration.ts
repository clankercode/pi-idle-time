/**
 * Elapsed time formatting for the statusline.
 */

export function formatElapsed(
  valueMs: number | null | undefined,
  opts: { dropSecondsAfterSeconds: number },
): string | null {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(valueMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes >= 1440) {
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    return `${days}d${hours}h`;
  }

  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h${minutes}m`;
  }

  if (totalSeconds >= opts.dropSecondsAfterSeconds) {
    return `${totalMinutes}m`;
  }

  const seconds = totalSeconds % 60;
  return `${totalMinutes}m${seconds}s`;
}
