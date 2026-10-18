import { describe, expect, it } from 'vitest';
import { timeAgo } from './time';

describe('timeAgo', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  it('counts minutes, hours and days in the last week', () => {
    expect(timeAgo('2026-10-16T11:59:30Z', now)).toBe('now');
    expect(timeAgo('2026-10-16T11:55:00Z', now)).toBe('5m');
    expect(timeAgo('2026-10-16T09:00:00Z', now)).toBe('3h');
    expect(timeAgo('2026-10-14T12:00:00Z', now)).toBe('2d');
  });
  it('names the date past a week, and the year once it is another year', () => {
    expect(timeAgo('2026-10-04T12:00:00Z', now)).toBe('Oct 4');
    expect(timeAgo('2025-12-30T12:00:00Z', now)).toBe('Dec 30, 2025');
  });
});
