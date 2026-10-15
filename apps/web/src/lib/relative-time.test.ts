import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const NOW = new Date('2026-10-06T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('relativeTime', () => {
  it.each([
    [0, 'now'],
    [44, 'now'],
    [45, '1 minute ago'],
    [5 * 60, '5 minutes ago'],
    [59 * 60, '59 minutes ago'],
    [3600, '1 hour ago'],
    [5 * 3600, '5 hours ago'],
    [24 * 3600, 'yesterday'],
    [3 * 24 * 3600, '3 days ago'],
    [30 * 24 * 3600, 'last month'],
    [400 * 24 * 3600, 'last year'],
  ])('%i seconds ago reads "%s"', (seconds, expected) => {
    expect(relativeTime(ago(seconds), NOW)).toBe(expected);
  });

  it('reads a time in the future as "now"', () => {
    expect(relativeTime(ago(-3600), NOW)).toBe('now');
  });

  it('returns an empty string for a value that is not a date', () => {
    expect(relativeTime('not a date', NOW)).toBe('');
    expect(relativeTime('', NOW)).toBe('');
  });
});
