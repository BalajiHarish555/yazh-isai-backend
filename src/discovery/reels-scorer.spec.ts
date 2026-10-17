import { describe, expect, it } from 'vitest';
import {
  ReelCandidate,
  ReelScoringContext,
  normalizeTitle,
  resolveAvailability,
  scoreCandidates,
  stableHash,
} from './reels-scorer';

function cand(over: Partial<ReelCandidate> = {}): ReelCandidate {
  return {
    id: 'AAAAAAAAAAA',
    title: 'Song',
    artist: 'Artist',
    provider: 'youtube',
    ...over,
  };
}

const ctx = (over: Partial<ReelScoringContext> = {}): ReelScoringContext => ({
  seed: 'test-seed',
  ...over,
});

describe('reels-scorer', () => {
  it('returns an empty list for empty/invalid input', () => {
    expect(scoreCandidates([], ctx())).toEqual([]);
    const bad = [
      cand({ id: '' }),
      cand({ title: '' }),
      { title: 'no id at all' } as unknown as ReelCandidate,
      null as unknown as ReelCandidate,
    ];
    expect(scoreCandidates(bad, ctx())).toEqual([]);
  });

  it('dedupes by id and by normalized title', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Vaathi Combo' }),
        cand({ id: 'bbbbbbbbbbb', title: 'Vaathi Combo!' }),
        cand({ id: 'aaaaaaaaaaa', title: 'Different Title' }),
        cand({ id: 'ccccccccccc', title: 'Other Song' }),
      ],
      ctx(),
    );
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(['aaaaaaaaaaa', 'ccccccccccc']);
    expect(normalizeTitle('Vaathi (Combo)!')).toBe('vaathi combo');
  });

  it('is deterministic: same candidates + seed => same order and feedIds', () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      cand({
        id: `id${String(i).padStart(9, '0')}`,
        title: `Track ${i}`,
        artist: `Artist ${i % 5}`,
        rank: i % 4 === 0 ? 0 : 5, // create score ties to exercise tie-breaks
      }),
    );
    const a = scoreCandidates(pool, ctx({ seed: 's1' }));
    const b = scoreCandidates([...pool].reverse(), ctx({ seed: 's1' }));
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a.map((i) => i.feedId)).toEqual(b.map((i) => i.feedId));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('breaks score ties with the seed hash, deterministically', () => {
    const x = cand({ id: 'xxxxxxxxxxx', title: 'X', rank: 0 });
    const y = cand({ id: 'yyyyyyyyyyy', title: 'Y', rank: 0 });
    const items = scoreCandidates([x, y], ctx({ seed: 'abc' }));
    const hx = stableHash('abc:xxxxxxxxxxx');
    const hy = stableHash('abc:yyyyyyyyyyy');
    const expectedFirst = hx <= hy ? 'xxxxxxxxxxx' : 'yyyyyyyyyyy';
    expect(items[0].id).toBe(expectedFirst);
  });

  it('hard-excludes not_interested by id and hidden titles', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Hidden One' }),
        cand({ id: 'bbbbbbbbbbb', title: 'Vaathi (Combo)' }),
        cand({ id: 'ccccccccccc', title: 'Visible' }),
      ],
      ctx({
        feedback: { hiddenIds: ['aaaaaaaaaaa'], hiddenTitles: ['vaathi combo'] },
      }),
    );
    expect(items.map((i) => i.id)).toEqual(['ccccccccccc']);
  });

  it('boosts likes and down-ranks skips', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Plain', rank: 0 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Liked', rank: 5 }),
        cand({ id: 'ccccccccccc', title: 'Skipped', rank: 0 }),
      ],
      ctx({ feedback: { likedIds: ['bbbbbbbbbbb'], skippedIds: ['ccccccccccc'] } }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.bbbbbbbbbbb.score).toBeGreaterThan(byId.aaaaaaaaaaa.score);
    expect(byId.ccccccccccc.score).toBeLessThan(byId.aaaaaaaaaaa.score);
    expect(byId.ccccccccccc.score).toBeGreaterThanOrEqual(0);
    expect(byId.bbbbbbbbbbb.reasons).toContain('You liked this');
  });

  it('matches likes by title for library snapshots with foreign ids', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Library Song', rank: 10 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Other', rank: 0 }),
      ],
      ctx({ feedback: { likedTitles: ['library song'] } }),
    );
    expect(items[0].id).toBe('aaaaaaaaaaa');
    expect(items[0].reasons).toContain('You liked this');
  });

  it('applies mood tags (id and aliases) with a reason', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Mood Hit', moodTags: ['chill'], rank: 10 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Alias Hit', moodTags: ['peaceful'], rank: 10 }),
        cand({ id: 'ccccccccccc', title: 'No Mood', moodTags: ['dark'], rank: 10 }),
      ],
      ctx({ mood: 'chill', moodTags: ['chill', 'peaceful'] }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.aaaaaaaaaaa.score).toBeGreaterThan(byId.ccccccccccc.score);
    expect(byId.bbbbbbbbbbb.score).toBeGreaterThan(byId.ccccccccccc.score);
    expect(byId.aaaaaaaaaaa.reasons).toContain('Chill mood');
  });

  it('tags feed-language matches with an "In {lang}" reason for cold accounts', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Tamil Song', language: 'tamil', rank: 10 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Hindi Song', language: 'hindi', rank: 10 }),
        cand({ id: 'ccccccccccc', title: 'Untagged Song', rank: 10 }),
      ],
      ctx({ lang: 'tamil' }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.aaaaaaaaaaa.reasons).toContain('In Tamil');
    expect(byId.bbbbbbbbbbb.reasons).not.toContain('In Tamil');
    expect(byId.ccccccccccc.reasons).not.toContain('In Tamil');
    expect(byId.aaaaaaaaaaa.score).toBeGreaterThan(byId.bbbbbbbbbbb.score);
  });

  it('applies saved artist preference with a reason', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Mine', artists: ['Anirudh'], rank: 10 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Stranger', artists: ['Nobody'], rank: 10 }),
      ],
      ctx({ prefs: { artists: ['anirudh'] } }),
    );
    expect(items[0].id).toBe('aaaaaaaaaaa');
    expect(items[0].reasons).toContain('More from Anirudh');
  });

  it('caps repeats per artist and refills from overflow', () => {
    const pool: ReelCandidate[] = [];
    for (let i = 0; i < 5; i++) {
      pool.push(
        cand({
          id: `aaaaaaaaa0${i}`,
          title: `Star ${i}`,
          artists: ['Star Artist'],
          rank: i, // top ranks, all one artist
        }),
      );
    }
    pool.push(cand({ id: 'bbbbbbbbbbb', title: 'Fresh', artists: ['Other'], rank: 30 }));
    const items = scoreCandidates(pool, ctx());
    const ids = items.map((i) => i.id);
    // At most3 Star items may appear before any Star item ranks below Fresh.
    const starIdx = ids.map((id, i) => (id.startsWith('aaaaaaaaa') ? i : -1)).filter((i) => i >= 0);
    const freshIdx = ids.indexOf('bbbbbbbbbbb');
    expect(starIdx.slice(0, 3).every((i) => i < freshIdx)).toBe(true);
    expect(starIdx[3]).toBeGreaterThan(freshIdx);
    expect(ids).toHaveLength(6); // overflow never drops candidates
  });

  it('reports honest availability states', () => {
    expect(resolveAvailability({ id: 'saavn-abc123', provider: 'saavn' })).toBe('playable');
    expect(resolveAvailability({ id: 'saavn-', provider: 'saavn' })).toBe('unavailable');
    expect(resolveAvailability({ id: 'dQw4w9WgXcQ', provider: 'youtube' })).toBe('playable');
    expect(resolveAvailability({ id: 'not-a-video-id!', provider: 'youtube' })).toBe('unavailable');
    expect(resolveAvailability({ id: 'dQw4w9WgXcQ', provider: 'youtube', preview: true })).toBe('preview_only');
    expect(
      resolveAvailability({ id: 'dQw4w9WgXcQ', provider: 'youtube', externalUrl: 'https://x' }),
    ).toBe('external_only');
    expect(
      resolveAvailability({ id: '0b5e4f9a-1234-4321-8888-000000000000', provider: 'catalog' }),
    ).toBe('unavailable');
    expect(resolveAvailability({ id: 'dQw4w9WgXcQ', provider: 'catalog' })).toBe('playable');
    expect(resolveAvailability({ id: '', provider: 'youtube' })).toBe('unavailable');
  });

  it('keeps reasons to the top two', () => {
    const items = scoreCandidates(
      [
        cand({
          id: 'aaaaaaaaaaa',
          title: 'Everything',
          artists: ['Anirudh'],
          genre: 'Pop',
          language: 'Tamil',
          moodTags: ['chill'],
          rank: 0,
        }),
      ],
      ctx({
        mood: 'chill',
        moodTags: ['chill'],
        prefs: { artists: ['anirudh'], genres: ['pop'], languages: ['tamil'] },
      }),
    );
    expect(items[0].reasons.length).toBeLessThanOrEqual(2);
    expect(items[0].reasons.length).toBeGreaterThan(0);
  });

  it('feeds every item a stable feedId derived from seed + id', () => {
    const items = scoreCandidates([cand({ id: 'aaaaaaaaaaa' })], ctx({ seed: 'seed1' }));
    expect(items[0].feedId).toBe(`f_${stableHash('seed1|aaaaaaaaaaa').toString(36)}`);
  });

  it('applies learned taste to EXTERNAL candidates (singer/language match)', () => {
    const taste = {
      genres: [],
      languages: [{ name: 'tamil', affinity: 1 }],
      singers: [{ name: 'ilaiyaraaja', affinity: 1 }],
      composers: [],
      moods: [],
      eras: [],
      dislikes: { singers: [], genres: [], languages: [], moods: [], eras: [] },
      energy: 0.5,
      totalWeight: 12,
      dislikeWeight: 0,
      trackCount: 10,
    };
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Old Melody', artists: ['Ilaiyaraaja'], rank: 40 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Stranger Hit', artists: ['Newcomer'], rank: 40 }),
      ],
      ctx({ taste: taste as any }),
    );
    expect(items[0].id).toBe('aaaaaaaaaaa');
    expect(items[0].score).toBeGreaterThan(items[1].score);
    expect(items[0].reasons.join(' ')).toContain('Ilaiyaraaja');
  });

  it('lets learned dislikes sink matches below neutral candidates', () => {
    const taste = {
      genres: [],
      languages: [],
      singers: [],
      composers: [],
      moods: [],
      eras: [],
      dislikes: { singers: [{ name: 'skip artist', affinity: 1 }], genres: [], languages: [], moods: [], eras: [] },
      energy: 0.5,
      totalWeight: 0,
      dislikeWeight: 4,
      trackCount: 6,
    };
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Hated', artists: ['Skip Artist'], rank: 5 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Neutral', artists: ['Nobody'], rank: 5 }),
      ],
      ctx({ taste: taste as any, discovery: false }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.aaaaaaaaaaa.score).toBeLessThan(byId.bbbbbbbbbbb.score);
    expect(byId.aaaaaaaaaaa.score).toBeGreaterThanOrEqual(0); // never below the floor
  });

  it('boosts candidates matching recent search queries, with a reason', () => {
    const items = scoreCandidates(
      [
        cand({ id: 'aaaaaaaaaaa', title: 'Ilaiyaraaja Old Melody', artists: ['Someone'], rank: 0 }),
        cand({ id: 'bbbbbbbbbbb', title: 'Unrelated', artists: ['Other'], rank: 40 }),
      ],
      ctx({ searchTokens: ['ilaiyaraaja old melodies'] }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    // Title matches tokens ('ilaiyaraaja', 'old') → search-intent bonus.
    expect(byId.aaaaaaaaaaa.reasons).toContain('Matches your recent search');
    expect(byId.aaaaaaaaaaa.score).toBeGreaterThan(byId.bbbbbbbbbbb.score);
  });

  it('composes the feed into familiar/similar/discovery buckets, once each, deterministically', () => {
    //15 familiar (liked), 10 similar (taste language adjacency), 10 fresh.
    const pool: ReelCandidate[] = [];
    const likedIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = `fam${String(i).padStart(8, '0')}`;
      likedIds.push(id);
      pool.push(cand({ id, title: `Familiar ${i}`, artist: `Fam Artist ${i}`, rank: i }));
    }
    for (let i = 0; i < 10; i++) {
      pool.push(
        cand({ id: `sim${String(i).padStart(8, '0')}`, title: `Similar ${i}`, artist: `Similar Artist ${i}`, language: 'tamil', rank: 10 + i }),
      );
    }
    for (let i = 0; i < 10; i++) {
      pool.push(cand({ id: `dis${String(i).padStart(8, '0')}`, title: `Gem ${i}`, artist: `Gem Artist ${i}`, rank: 30 + i }));
    }
    const taste = {
      genres: [],
      languages: [{ name: 'tamil', affinity: 1 }],
      singers: [],
      composers: [],
      moods: [],
      eras: [],
      dislikes: { singers: [], genres: [], languages: [], moods: [], eras: [] },
      energy: 0.5,
      totalWeight: 8,
      dislikeWeight: 0,
      trackCount: 5,
    };
    const base = ctx({ seed: 'mixseed', limit: 20, feedback: { likedIds }, taste: taste as any });

    const a = scoreCandidates(pool, base);
    const b = scoreCandidates([...pool].reverse(), base);
    expect(a).toHaveLength(20);
    expect(new Set(a.map((i) => i.id)).size).toBe(20); // no dupes, no drops
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id)); // deterministic

    // 60/25/15 split: F12 S5 D3 for n=20 (largest-remainder counts).
    const buckets = { familiar: 0, similar: 0, discovery: 0 } as Record<string, number>;
    for (const i of a) buckets[i.bucket]++;
    expect(buckets).toEqual({ familiar: 12, similar: 5, discovery: 3 });

    // Familiar establishes the vibe up front; gems tagged honestly.
    expect(a[0].bucket).toBe('familiar');
    expect(a[1].bucket).toBe('familiar');
    const gems = a.filter((i) => i.discovery);
    expect(gems).toHaveLength(3);
    for (const g of gems) {
      expect(g.bucket).toBe('discovery');
      expect(g.reasons.length).toBeGreaterThan(0);
    }
  });

  it('adapts the gem share to the session appetite', () => {
    // Stock every bucket: 15 liked (familiar), 10 taste-adjacent (similar),
    // 15 fresh (discovery) — so targets bind and the ratio is observable.
    const pool: ReelCandidate[] = [];
    const likedIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = `aaaaaaaaa${String(i).padStart(2, '0')}`;
      likedIds.push(id);
      pool.push(cand({ id, title: `Like ${i}`, artist: `Liked Artist ${i}`, rank: i }));
    }
    for (let i = 0; i < 10; i++) {
      pool.push(
        cand({ id: `bbbbbbbbb${String(i).padStart(2, '0')}`, title: `Adj ${i}`, artist: `Similar Artist ${i}`, language: 'tamil', rank: 10 + i }),
      );
    }
    for (let i = 0; i < 15; i++) {
      pool.push(cand({ id: `ccccccccc${String(i).padStart(2, '0')}`, title: `Gem ${i}`, artist: `Gem Artist ${i}`, rank: 30 + i }));
    }
    const taste = {
      genres: [],
      languages: [{ name: 'tamil', affinity: 1 }],
      singers: [],
      composers: [],
      moods: [],
      eras: [],
      dislikes: { singers: [], genres: [], languages: [], moods: [], eras: [] },
      energy: 0.5,
      totalWeight: 8,
      dislikeWeight: 0,
      trackCount: 5,
    };
    const countDisco = (appetite: number) =>
      scoreCandidates(
        pool,
        ctx({ seed: 'app', limit: 20, appetite, feedback: { likedIds }, taste: taste as any }),
      ).filter((i) => i.discovery).length;
    const baseline = countDisco(0.15); // default appetite → 3 of20 (15%)
    const hungry = countDisco(0.3); // appetite max → more gems
    expect(baseline).toBe(3);
    expect(hungry).toBeGreaterThan(baseline);
    expect(hungry).toBeLessThanOrEqual(8); // capped: never dominates the feed
  });

  it('sinks recent repeats (soft penalty, never a block)', () => {
    const pool = [
      cand({ id: 'aaaaaaaaaaa', title: 'Played Recently', artist: 'Played Artist', moodTags: ['chill'], rank: 5 }),
      cand({ id: 'bbbbbbbbbbb', title: 'Fresh Pick', artist: 'Other Artist', moodTags: ['chill'], rank: 5 }),
      cand({ id: 'ccccccccccc', title: 'Way Back', artist: 'Other Artist', moodTags: ['chill'], rank: 5 }),
    ];
    const items = scoreCandidates(
      pool,
      ctx({
        discovery: false,
        mood: 'chill',
        moodTags: ['chill'],
        behavior: {
          recentPlays: ['played recently', 'way back'], // newest first; first 8 = harsh
          recentIds: ['aaaaaaaaaaa'],
        },
      }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(items).toHaveLength(3); // penalties sink, never drop
    expect(byId.bbbbbbbbbbb.score).toBeGreaterThan(byId.aaaaaaaaaaa.score);
    // Very recent id hit (−3) sinks below a recent title repeat (−2.5).
    expect(byId.aaaaaaaaaaa.score).toBeLessThan(byId.ccccccccccc.score);
  });

  it('learns the session: singer completions lift, repeated skips sink softly', () => {
    const pool = [
      cand({ id: 'aaaaaaaaaaa', title: 'Session Fave', artist: 'Loved Artist', rank: 20 }),
      cand({ id: 'bbbbbbbbbbb', title: 'Session Skip', artist: 'Skipped Artist', rank: 5 }),
      cand({ id: 'ccccccccccc', title: 'Neutral One', artist: 'Nobody', rank: 5 }),
    ];
    const items = scoreCandidates(
      pool,
      ctx({
        discovery: false,
        session: {
          singerCompletions: { 'loved artist': 3 },
          singerSkips: { 'skipped artist': 2 },
        },
      }),
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.aaaaaaaaaaa.score).toBeGreaterThan(byId.ccccccccccc.score);
    expect(byId.bbbbbbbbbbb.score).toBeLessThan(byId.ccccccccccc.score);
    expect(items).toHaveLength(3); // one skip pattern can never block an artist
    expect(byId.aaaaaaaaaaa.bucket).toBe('familiar'); // session love counts as familiar
  });

  it('ranks behaviour: replays > completes > skips for the same title', () => {
    const pool = [
      cand({ id: 'aaaaaaaaaaa', title: 'Same Song', rank: 5 }),
      cand({ id: 'bbbbbbbbbbb', title: 'Other Song', rank: 5 }),
    ];
    const behaviorFor = (slot: { completions: number; skips: number; replays: number }) => ({
      titles: { 'same song': slot },
    });
    const scoreOf = (behavior?: any) => {
      const items = scoreCandidates(pool, ctx({ discovery: false, behavior }));
      return Object.fromEntries(items.map((i) => [i.id, i])).aaaaaaaaaaa.score;
    };
    const replay = scoreOf(behaviorFor({ completions: 1, skips: 0, replays: 2 }));
    const complete = scoreOf(behaviorFor({ completions: 3, skips: 0, replays: 0 }));
    const skip = scoreOf(behaviorFor({ completions: 0, skips: 3, replays: 0 }));
    const plain = scoreOf();
    expect(replay).toBeGreaterThan(complete);
    expect(complete).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(skip);
    expect(skip).toBeGreaterThanOrEqual(0);
  });

  it('returns only up to the requested limit via composition', () => {
    const pool = Array.from({ length: 30 }, (_, i) =>
      cand({ id: `aaaaaaaaa${String(i).padStart(2, '0')}`, title: `T${i}`, artist: `A${i}`, rank: i }),
    );
    const items = scoreCandidates(pool, ctx({ seed: 'lim', limit: 9 }));
    expect(items).toHaveLength(9);
    const all = scoreCandidates(pool, ctx({ seed: 'lim' }));
    expect(all).toHaveLength(30); // no limit → whole pool, still composed
  });
});
