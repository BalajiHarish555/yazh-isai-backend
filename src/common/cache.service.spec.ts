import { describe, expect, it } from 'vitest';
import { CacheService } from './cache.service';

describe('CacheService (in-memory fallback)', () => {
  it('round-trips values and misses cleanly', async () => {
    const cache = new CacheService();
    expect(await cache.get('nope')).toBeNull();
    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get('k')).toEqual({ a: 1 });
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('expires entries past their TTL', async () => {
    const cache = new CacheService();
    await cache.set('short', 'x', 1);
    expect(await cache.get('short')).toBe('x');
    await new Promise((r) => setTimeout(r, 1100));
    expect(await cache.get('short')).toBeNull();
  });
});
