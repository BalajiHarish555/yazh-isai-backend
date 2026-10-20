import { describe, expect, it } from 'vitest';
import {
  MAX_SEEN_IDS,
  decodeFeedCursor,
  encodeFeedCursor,
  extendSeen,
} from './feed-cursor';

const base = {
  seed: 's1',
  mood: 'chill',
  lang: 'tamil',
  page: 1,
  seen: [] as string[],
};

describe('feed-cursor', () => {
  it('round-trips a cursor', () => {
    const c = { ...base, seen: ['a', 'b', 'c'], page: 2 };
    const decoded = decodeFeedCursor(encodeFeedCursor(c));
    expect(decoded).toEqual({ ...c, page: 2 });
  });

  it('round-trips null mood', () => {
    const decoded = decodeFeedCursor(encodeFeedCursor({ ...base, mood: null }));
    expect(decoded?.mood).toBeNull();
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'not-base64!!!', Buffer.from('{').toString('base64url'), 'x'.repeat(
      5000,
    )]) {
      expect(decodeFeedCursor(bad)).toBeNull();
    }
    expect(decodeFeedCursor(undefined as any)).toBeNull();
    expect(decodeFeedCursor(42 as any)).toBeNull();
  });

  it('caps the seen list at MAX_SEEN_IDS', () => {
    const seen = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const decoded = decodeFeedCursor(encodeFeedCursor({ ...base, seen }));
    expect(decoded!.seen.length).toBeLessThanOrEqual(MAX_SEEN_IDS);
    expect(decoded!.seen[decoded!.seen.length - 1]).toBe('t99'); // newest kept
  });

  it('extendSeen dedupes and bounds', () => {
    const next = extendSeen(['a', 'b'], ['b', 'c', 'c']);
    expect(next).toEqual(['a', 'b', 'c']);
    const many = extendSeen([], Array.from({ length: 60 }, (_, i) => `x${i}`));
    expect(many.length).toBeLessThanOrEqual(MAX_SEEN_IDS);
  });

  it('page floors at 1', () => {
    const decoded = decodeFeedCursor(encodeFeedCursor({ ...base, page: -3 as any }));
    expect(decoded?.page).toBe(1);
  });
});
