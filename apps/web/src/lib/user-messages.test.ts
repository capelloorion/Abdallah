import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_SECONDS, parseRetryAfter, rateLimitedMessage } from './user-messages';

describe('parseRetryAfter', () => {
  it.each([
    ['1', 1],
    ['5', 5],
    [' 30 ', 30],
    ['3600', 3600],
  ])('reads %j as %i seconds', (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });

  it.each([
    ['missing', null],
    ['undefined', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['absurdly large', String(MAX_RETRY_AFTER_SECONDS + 1)],
    ['a huge number', '99999999999'],
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['text', 'soon'],
    ['an exponent', '1e3'],
    ['a sign', '+5'],
  ])('ignores %s', (_label, value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });
});

describe('rateLimitedMessage', () => {
  it.each([
    [undefined, 'Too many requests. Try again in a moment.'],
    [1, 'Too many requests. Try again in 1 second.'],
    [5, 'Too many requests. Try again in 5 seconds.'],
    [89, 'Too many requests. Try again in 89 seconds.'],
    [90, 'Too many requests. Try again in about 2 minutes.'],
    [600, 'Too many requests. Try again in about 10 minutes.'],
    [MAX_RETRY_AFTER_SECONDS, 'Too many requests. Try again in about 60 minutes.'],
  ])('%s seconds reads "%s"', (seconds, expected) => {
    expect(rateLimitedMessage(seconds)).toBe(expected);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_RETRY_AFTER_SECONDS + 1])(
    'falls back to "in a moment" for the unusable value %s',
    (bad) => {
      expect(rateLimitedMessage(bad)).toBe('Too many requests. Try again in a moment.');
    },
  );
});
