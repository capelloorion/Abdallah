const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "5 minutes ago", "yesterday", "now". Returns `''` for a value that is not a date, so a bad
 * timestamp never shows "Invalid Date" or "NaN". A time in the future reads as "now" (clock skew).
 * `now` is a parameter so the result is deterministic in tests.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 45) return 'now';
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return FORMAT.format(-Math.floor(seconds / size), unit);
  }
  return FORMAT.format(-1, 'minute');
}
