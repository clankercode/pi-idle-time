/**
 * ISO timestamp utilities for idle-time tracking.
 */

export function toIsoUtc(value: string | Date): string {
  return new Date(value).toISOString();
}

export function toLocalIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absOff = Math.abs(offsetMin);
  const offH = pad(Math.floor(absOff / 60));
  const offM = pad(absOff % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${sign}${offH}:${offM}`;
}

export function getNowIso(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  nowFactory: () => Date = () => new Date(),
): string {
  return env.PI_IDLE_TIMING_NOW_ISO || toLocalIso(nowFactory());
}

export function stripMs(iso: string): string {
  return iso.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "");
}

export function diffMs(laterIso: string | undefined | null, earlierIso: string | undefined | null): number | null {
  if (!laterIso || !earlierIso) {
    return null;
  }

  const laterMs = Date.parse(laterIso);
  const earlierMs = Date.parse(earlierIso);

  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) {
    return null;
  }

  return laterMs - earlierMs;
}
