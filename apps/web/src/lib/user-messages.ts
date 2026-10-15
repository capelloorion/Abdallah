/**
 * Plain wording for failures a person can act on. Built only from a number the BFF or api sent
 * (and checked), never from any server text.
 */

/** The longest wait we will quote; a larger or invalid `Retry-After` is ignored. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * A `Retry-After` header as whole seconds, or `undefined` when it is missing, not a plain
 * number (an HTTP date is not used), zero, negative, fractional or absurdly large.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

/** "Too many requests. Try again in 5 seconds." — or "in a moment" when the wait is unknown. */
export function rateLimitedMessage(retryAfterSeconds?: number): string {
  const seconds =
    retryAfterSeconds !== undefined &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 1 &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
      ? retryAfterSeconds
      : undefined;
  if (seconds === undefined) return 'Too many requests. Try again in a moment.';
  if (seconds === 1) return 'Too many requests. Try again in 1 second.';
  if (seconds < 90) return `Too many requests. Try again in ${seconds} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Too many requests. Try again in about ${minutes} minutes.`;
}
