import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ReelsFeedService } from './reels-feed.service';
import { MoodEngineService } from './mood-engine.service';

function saavnRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `saavn-song${i}`,
    title: `Trending Song ${i}`,
    artists: `Chart Artist ${i % 4}`,
    thumbnail: 'https://img/t.jpg',
    duration: 200,
    source: 'Trending â€¢ JioSaavn',
    ...over,
  };
}

function makeService(overrides: {
  trending?: any;
  search?: any;
  catalogTracks?: any[];
  user?: any;
  profile?: any;
  reelEvents?: any[];
  listeningEvents?: any[];
  tasteProfile?: any;
  searchTokens?: string[];
  cachedPool?: any;
} = {}) {
  const prisma: any = {
    track: { findMany: vi.fn().mockResolvedValue(overrides.catalogTracks || []) },
    user: { findUnique: vi.fn().mockResolvedValue(overrides.user ?? null) },
    profile: { findUnique: vi.fn().mockResolvedValue(overrides.profile ?? null) },
    listeningEvent: {
      findMany: vi.fn().mockResolvedValue(overrides.listeningEvents || []),
    },
    reelEvent: {
      findMany: vi.fn().mockResolvedValue(overrides.reelEvents || []),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    searchIntent: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    userPreferences: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
  // Passing an Error as an override means "this source rejects".
  const result = (v: any) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const jioSaavn: any = {
    getTrendingSongs:
      overrides.trending !== undefined
        ? vi.fn().mockImplementation(() => result(overrides.trending))
        : vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, i) => saavnRow(i))),
  };
  const youtube: any = {
    searchTracks:
      overrides.search !== undefined
        ? vi.fn().mockImplementation(() => result(overrides.search))
        : vi.fn().mockResolvedValue([
            {
              id: 'dQw4w9WgXcQ',
              title: 'Mood Matching Hit',
              artists: 'Mood Artist',
              thumbnail: 'https://img/m.jpg',
              duration: 180,
              source: 'YouTube Music',
            },
          ]),
  };
  const cache = {
    get: vi.fn().mockResolvedValue(overrides.cachedPool ?? null),
    set: vi.fn().mockResolvedValue(undefined),
  };
  const taste = {
    getProfileForUser: vi.fn().mockResolvedValue(overrides.tasteProfile ?? null),
    getRecentSearchTokens: vi.fn().mockResolvedValue(overrides.searchTokens ?? []),
  };

  const session = {
    record: vi.fn(),
    clear: vi.fn(),
    context: vi.fn().mockReturnValue(null),
  };

  const service = new ReelsFeedService(
    prisma,
    jioSaavn,
    youtube,
    new MoodEngineService(),
    taste as any,
    cache as any,
    session as any,
  );
  return { service, prisma, jioSaavn, youtube, cache, taste, session };
}

describe('ReelsFeedService.getFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a ranked, well-formed feed with mood results on top', async () => {
    const { service, youtube } = makeService();
    const feed = await service.getFeed({ mood: 'chill', lang: 'tamil', limit: 10, seed: 's1' });
    expect(feed.seed).toBe('s1');
    expect(feed.mood).toBe('chill');
    expect(feed.count).toBeGreaterThan(0);
    expect(feed.count).toBeLessThanOrEqual(10);
    // Mood-search candidates are tagged + boosted, so the mood hit leads.
    expect(feed.items[0].id).toBe('dQw4w9WgXcQ');
    const first = feed.items[0];
    expect(first.feedId).toBeTruthy();
    expect(first.availability).toBe('playable');
    expect(typeof first.score).toBe('number');
    expect(Array.isArray(first.reasons)).toBe(true);
    // Every item carries the fields the Reels client needs to render.
    for (const it of feed.items) {
      expect(it.id).toBeTruthy();
      expect(it.title).toBeTruthy();
      expect(it.artist).toBeTruthy();
      expect(['playable', 'preview_only', 'external_only', 'unavailable']).toContain(
        it.availability,
      );
    }
    expect(youtube.searchTracks).toHaveBeenCalledWith('tamil chill relaxed melody songs');
    expect(youtube.searchTracks).toHaveBeenCalledTimes(1);
  });

  it('clamps the limit to 5..30', async () => {
    const { service } = makeService();
    const big = await service.getFeed({ limit: 999, seed: 'x' });
    expect(big.count).toBeLessThanOrEqual(30);
    const small = await service.getFeed({ limit: 1, seed: 'x' });
    expect(small.count).toBeGreaterThanOrEqual(5);
  });

  it('serves a mood feed even when Saavn trending fails', async () => {
    const { service } = makeService({
      trending: new Error('saavn down'),
    });
    const feed = await service.getFeed({ mood: 'chill', limit: 10, seed: 's' });
    expect(feed.count).toBeGreaterThan(0);
    expect(feed.items[0].id).toBe('dQw4w9WgXcQ');
  });

  it('serves trending when the mood search fails', async () => {
    const { service } = makeService({ search: new Error('yt down') });
    const feed = await service.getFeed({ mood: 'energy', limit: 10, seed: 's' });
    expect(feed.count).toBeGreaterThan(0);
    expect(feed.items.every((i) => i.id.startsWith('saavn-'))).toBe(true);
  });

  it('returns an empty feed gracefully when every source fails', async () => {
    const { service } = makeService({ trending: new Error('x'), search: new Error('y') });
    const feed = await service.getFeed({ mood: 'dark', seed: 's' });
    expect(feed.count).toBe(0);
    expect(feed.items).toEqual([]);
  });

  it('is deterministic for the same seed and inputs', async () => {
    const { service } = makeService();
    const a = await service.getFeed({ mood: 'chill', seed: 'stable', limit: 10 });
    const b = await service.getFeed({ mood: 'chill', seed: 'stable', limit: 10 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items.map((i) => i.feedId)).toEqual(b.items.map((i) => i.feedId));
  });

  it('excludes not_interested, boosts likes and honors prefs for logged-in users', async () => {
    const { service } = makeService({
      user: {
        preferences: {
          preferredMoods: '["chill"]',
          preferredGenres: '[]',
          preferredArtists: '["Chart Artist 1"]',
          preferredLanguages: '["Tamil"]',
          preferredEnergy: null,
        },
      },
      profile: {
        library: JSON.stringify({
          liked: [{ id: 'saavn-song9', title: 'Trending Song 9' }],
          playlists: [],
        }),
      },
      reelEvents: [
        { trackId: 'saavn-song0', eventType: 'not_interested' },
        { trackId: 'saavn-song1', eventType: 'skip' },
        { trackId: 'saavn-song2', eventType: 'like' },
      ],
    });
    const feed = await service.getFeed({ userId: 'user-1', mood: 'chill', limit: 30, seed: 's' });
    const ids = feed.items.map((i) => i.id);
    expect(ids).not.toContain('saavn-song0'); // hidden
    expect(feed.items.find((i) => i.id === 'saavn-song2')?.score).toBeGreaterThan(0);
    const liked = feed.items.find((i) => i.id === 'saavn-song9');
    expect(liked?.reasons).toContain('You liked this');
    // song1 shares song5's artist-preference boost (Chart Artist 1), so the
    // only delta between them is the recorded skip: song1 must rank lower.
    const song1 = feed.items.find((i) => i.id === 'saavn-song1')?.score ?? 0;
    const song5 = feed.items.find((i) => i.id === 'saavn-song5')?.score ?? 0;
    expect(song1).toBeLessThan(song5);
    expect(ids).toContain('dQw4w9WgXcQ');
  });
});

describe('ReelsFeedService.recordEvents', () => {
  it('rejects an empty/invalid payload', async () => {
    const { service } = makeService();
    await expect(service.recordEvents('u1', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.recordEvents('u1', { events: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('caps, whitelists and sanitizes events', async () => {
    const { service, prisma } = makeService();
    const events = [
      { trackId: 'saavn-a', eventType: 'impression', dwellMs: 1200 },
      { trackId: 'saavn-b', eventType: 'nonsense-type' },
      { trackId: '', eventType: 'play' },
      { trackId: 'saavn-c', eventType: 'play', dwellMs: -50, mood: 'Chill!', feedId: 'f_abc', title: 'Kal Ho Naa Ho', artist: 'Sonu Nigam' },
      { trackId: 'saavn-d', eventType: 'like', dwellMs: 99999999 },
      ...Array.from({ length: 60 }, (_, i) => ({ trackId: `x${i}`, eventType: 'skip' })),
    ];
    const res = await service.recordEvents('u1', { events });
    //65 in: first50 sliced, of which2 are invalid =>48 written;
    // everything past the50-cap plus the2 invalid =17 rejected.
    expect(res.recorded).toBe(48);
    expect(res.rejected).toBe(17);
    const rows = prisma.reelEvent.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({ userId: 'u1', trackId: 'saavn-a', eventType: 'impression', dwellMs: 1200 });
    expect(rows[0].title).toBeNull(); // snapshots are optional
    expect(rows[1]).toMatchObject({
      trackId: 'saavn-c',
      dwellMs: 0,
      mood: 'chill',
      feedId: 'f_abc',
      title: 'Kal Ho Naa Ho',
      artist: 'Sonu Nigam',
    });
    expect(rows[2].dwellMs).toBe(600000); // clamped down
    expect(rows.every((r: any) => r.userId === 'u1')).toBe(true);
  });

  it('prunes stale history after writing', async () => {
    const { service, prisma } = makeService();
    await service.recordEvents('u1', { events: [{ trackId: 'saavn-a', eventType: 'play' }] });
    expect(prisma.reelEvent.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.reelEvent.deleteMany.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });
});

describe('ReelsFeedService preferences', () => {
  it('returns defaults when the user has no preference row', async () => {
    const { service } = makeService();
    const prefs = await service.getPreferences('u1');
    expect(prefs).toEqual({ moods: [], genres: [], artists: [], languages: [], energy: null });
  });

  it('validates moods against the mood engine and clamps energy', async () => {
    const { service, prisma } = makeService();
    prisma.userPreferences.findUnique.mockResolvedValue({
      preferredGenres: '["pop"]',
      preferredArtists: '["Anirudh"]',
      preferredMoods: '["chill"]',
      preferredLanguages: '["Tamil"]',
      preferredEnergy: 0.5,
    });

    const res = await service.updatePreferences('u1', { moods: ['dark', 'bogus', 'ENERGY'] });
    expect(res.moods).toEqual(['dark', 'energy']);
    const upsert = prisma.userPreferences.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ userId: 'u1' });
    expect(JSON.parse(upsert.update.preferredGenres)).toEqual(['pop']); // untouched fields merge
    expect(upsert.update.preferredEnergy).toBe(0.5);

    await expect(service.updatePreferences('u1', { energy: 5 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const res2 = await service.updatePreferences('u1', { energy: null });
    expect(res2.energy).toBeNull();
  });
});

describe('ReelsFeedService.getForYou', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const usableTaste = {
    genres: [{ name: 'melody', affinity: 1 }],
    languages: [{ name: 'tamil', affinity: 1 }],
    singers: [{ name: 'ilaiyaraaja', affinity: 1 }],
    composers: [],
    moods: [],
    eras: [],
    dislikes: { singers: [], genres: [], languages: [], moods: [], eras: [] },
    energy: 0.5,
    totalWeight: 14,
    dislikeWeight: 0,
    trackCount: 12,
  };

  it('serves an anonymous popular feed with personalized=false', async () => {
    const { service, taste } = makeService();
    const feed = await service.getForYou({ limit: 10, seed: 'anon' });
    expect(feed.personalized).toBe(false);
    expect(feed.seed).toBe('anon');
    expect(feed.count).toBeGreaterThan(0);
    for (const it of feed.items) {
      expect(it.id).toBeTruthy();
      expect(it.title).toBeTruthy();
      expect(['playable', 'preview_only', 'external_only', 'unavailable']).toContain(it.availability);
    }
    expect(taste.getProfileForUser).not.toHaveBeenCalled();
    expect(taste.getRecentSearchTokens).not.toHaveBeenCalled();
  });

  it('personalises with taste + recent searches for logged-in users', async () => {
    const { service, taste, youtube } = makeService({
      tasteProfile: usableTaste,
      searchTokens: ['ilaiyaraaja old melodies', 'night mood songs'],
    });
    const feed = await service.getForYou({ userId: 'user-1', limit: 12, seed: 'p1' });
    expect(feed.personalized).toBe(true);
    expect(feed.count).toBeGreaterThan(0);
    // Intent queries: the user's own recent searches first, then learned artists.
    expect(youtube.searchTracks).toHaveBeenCalledWith('ilaiyaraaja old melodies');
    expect(youtube.searchTracks).toHaveBeenCalledWith('night mood songs');
    expect(youtube.searchTracks).toHaveBeenCalledWith('ilaiyaraaja tamil songs');
    // Taste reasons reach the client so the UI can explain the pick
    // (trend rows are chart-tagged 'tamil', which the profile matches).
    expect(feed.items.some((i) => i.reasons.includes('In Tamil'))).toBe(true);
    expect(taste.getProfileForUser).toHaveBeenCalledWith('user-1');
    expect(taste.getRecentSearchTokens).toHaveBeenCalledWith('user-1', 10);
  });

  it('clamps the limit to 5..30 and stays deterministic per seed', async () => {
    const { service } = makeService();
    const big = await service.getForYou({ limit: 999, seed: 'x' });
    expect(big.count).toBeLessThanOrEqual(30);
    const small = await service.getForYou({ limit: 1, seed: 'x' });
    expect(small.count).toBeGreaterThanOrEqual(5);

    const a = await service.getForYou({ seed: 'same', limit: 10 });
    const b = await service.getForYou({ seed: 'same', limit: 10 });
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items.map((i) => i.feedId)).toEqual(b.items.map((i) => i.feedId));
  });

  it('still serves charts when intent queries fail', async () => {
    const { service, youtube } = makeService({
      tasteProfile: usableTaste,
      searchTokens: ['some query'],
      search: new Error('yt down'),
    });
    const feed = await service.getForYou({ userId: 'user-1', limit: 10, seed: 's' });
    expect(feed.count).toBeGreaterThan(0);
    expect(feed.items.every((i) => i.id.startsWith('saavn-'))).toBe(true);
  });
});

describe('ReelsFeedService cursor continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('page 1 returns a nextCursor when the page is full; page 2 excludes page 1 ids', async () => {
    const { service } = makeService();
    const p1 = await service.getFeed({ seed: 's', limit: 5 });
    expect(p1.page).toBe(1);
    expect(p1.items.length).toBe(5);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await service.getFeed({ cursor: p1.nextCursor!, limit: 5 });
    expect(p2.page).toBe(2);
    const p1Ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.some((i) => p1Ids.has(i.id))).toBe(false);
    expect(p2.items.length).toBeGreaterThan(0);
  });

  it('terminates when the pool is exhausted (short page ? no cursor)', async () => {
    const { service } = makeService();
    const p1 = await service.getFeed({ seed: 's', limit: 5 });
    const p2 = await service.getFeed({ cursor: p1.nextCursor!, limit: 5 });
    const p3 = await service.getFeed({ cursor: p2.nextCursor!, limit: 5 });
    expect(p3.items.length).toBeLessThan(5);
    expect(p3.nextCursor).toBeNull();
  });

  it('a cursor owns the request context (query params are ignored while continuing)', async () => {
    const { service } = makeService();
    const p1 = await service.getFeed({ mood: 'chill', seed: 'ctx', limit: 5 });
    const p2 = await service.getFeed({
      cursor: p1.nextCursor!,
      mood: 'sad', // mood switch without a new seed — cursor context wins
      lang: 'malayalam',
      limit: 5,
    });
    expect(p2.mood).toBe('chill');
    expect(p2.seed).toBe('ctx');
    expect(p2.lang).toBe('tamil');
  });

  it('treats a malformed cursor as a fresh feed', async () => {
    const { service } = makeService();
    const feed = await service.getFeed({ cursor: 'garbage!!!', seed: 's', limit: 5 });
    expect(feed.page).toBe(1);
    expect(feed.items.length).toBe(5);
  });

  it('no nextCursor when the first page is short', async () => {
    const { service } = makeService({ trending: [saavnRow(1)] });
    const feed = await service.getFeed({ seed: 's', limit: 30 });
    expect(feed.items.length).toBeLessThan(30);
    expect(feed.nextCursor).toBeNull();
  });
});

describe('ReelsFeedService.resetRecommendations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears reel events, search intents and the live session', async () => {
    const { service, prisma, session } = makeService();
    prisma.reelEvent.deleteMany.mockResolvedValue({ count: 7 });
    prisma.searchIntent.deleteMany.mockResolvedValue({ count: 2 });

    const res = await service.resetRecommendations('user-1');
    expect(res).toEqual({ clearedReelEvents: 7, clearedSearchIntents: 2 });
    expect(prisma.reelEvent.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(prisma.searchIntent.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(session.clear).toHaveBeenCalledWith('user-1');
  });

  it('tolerates a missing search-intent table shape (count 0) but still clears reels', async () => {
    const { service, prisma, session } = makeService();
    prisma.reelEvent.deleteMany.mockResolvedValue({ count: 3 });
    prisma.searchIntent.deleteMany.mockRejectedValue(new Error('relation missing'));
    const res = await service.resetRecommendations('user-1');
    expect(res.clearedReelEvents).toBe(3);
    expect(res.clearedSearchIntents).toBe(0);
    expect(session.clear).toHaveBeenCalledWith('user-1');
  });

  it('rejects a missing userId', async () => {
    const { service } = makeService();
    await expect(service.resetRecommendations('')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReelsFeedService.getMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates reel + history events into outcome metrics', async () => {
    const { service, prisma } = makeService();
    prisma.reelEvent.findMany.mockResolvedValue([
      { eventType: 'play', dwellMs: 12000, artist: 'A', trackId: 't1', discovery: false },
      { eventType: 'play', dwellMs: 800, artist: 'B', trackId: 't2', discovery: true },
      { eventType: 'skip', dwellMs: 400, artist: 'C', trackId: 't3', discovery: false },
      { eventType: 'like', dwellMs: 0, artist: 'A', trackId: 't1', discovery: false },
    ]);
    prisma.listeningEvent.findMany.mockResolvedValue([
      { eventType: 'complete', position: 200, duration: 200, artist: 'A' },
      { eventType: 'skip', position: 20, duration: 200, artist: 'B' },
    ]);

    const m = await service.getMetrics('user-1', 14);
    expect(m.windowDays).toBe(14);
    expect(m.counts.plays).toBe(2);
    expect(m.counts.skips).toBe(1);
    expect(m.counts.likes).toBe(1);
    expect(m.meaningfulPlays).toBe(1);
    expect(m.rates.completionRate).toBeCloseTo(0.5, 5);
    expect(m.rates.discoveryShare).toBeCloseTo(0.25, 5);
    // Query window bounded
    const since = prisma.reelEvent.findMany.mock.calls[0][0].where.createdAt.gte;
    expect(since.getTime()).toBeLessThanOrEqual(Date.now());
    expect(since.getTime()).toBeGreaterThan(Date.now() - 15 * 86400000);
  });

  it('clamps windowDays to 1..365 and rejects missing userId', async () => {
    const { service } = makeService();
    expect((await service.getMetrics('u', 0)).windowDays).toBe(1);
    expect((await service.getMetrics('u', 9999)).windowDays).toBe(365);
    await expect(service.getMetrics('')).rejects.toBeInstanceOf(BadRequestException);
  });
});
