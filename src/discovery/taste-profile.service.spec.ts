import { describe, expect, it } from 'vitest';
import {
  buildTasteProfile,
  scoreTrack,
  PlaySignal,
  isUsableTaste,
  sanitizeHistoryEvent,
  sanitizeSearchQueries,
  splitArtists,
} from './taste-profile.service';

const NOW = Date.now();
const DAY = 86400000;

function sig(over: Partial<PlaySignal> = {}): PlaySignal {
  return {
    singers: [],
    energy: 0.5,
    completed: true,
    position: 200,
    duration: 200,
    playedAt: NOW,
    ...over,
  };
}

describe('taste profile', () => {
  it('learns the dominant singer, genre and language', () => {
    const signals = [
      sig({ singers: ['Anirudh Ravichander'], genre: 'Pop', language: 'Tamil' }),
      sig({ singers: ['Anirudh Ravichander'], genre: 'Pop', language: 'Tamil' }),
      sig({ singers: ['Anirudh Ravichander'], genre: 'Dance', language: 'Tamil' }),
      sig({ singers: ['Sid Sriram'], genre: 'Melody', language: 'Tamil' }),
    ];
    const p = buildTasteProfile(signals, NOW);
    expect(p.singers[0].name).toBe('anirudh ravichander');
    expect(p.singers[0].affinity).toBe(1);
    expect(p.genres[0].name).toBe('pop');
    expect(p.languages[0].name).toBe('tamil');
    expect(p.trackCount).toBe(4);
  });

  it('weighs recent plays over old ones', () => {
    const signals = [
      sig({ singers: ['Old Artist'], playedAt: NOW - 60 * DAY }),
      sig({ singers: ['New Artist'], playedAt: NOW }),
    ];
    const p = buildTasteProfile(signals, NOW);
    expect(p.singers[0].name).toBe('new artist');
  });

  it('weighs full listens over skips', () => {
    const signals = [
      sig({ singers: ['Skippy'], completed: false, position: 20, duration: 200, playedAt: NOW }),
      sig({ singers: ['Skippy'], completed: false, position: 20, duration: 200, playedAt: NOW }),
      sig({ singers: ['Finisher'], completed: true, playedAt: NOW }),
    ];
    const p = buildTasteProfile(signals, NOW);
    expect(p.singers[0].name).toBe('finisher');
  });

  it('scores a matching track above a stranger, with reasons', () => {
    const p = buildTasteProfile(
      [sig({ singers: ['Anirudh Ravichander'], genre: 'Pop', language: 'Tamil', mood: 'happy' })],
      NOW,
    );
    const mine = scoreTrack(p, {
      singers: ['Anirudh Ravichander'],
      genre: 'Pop',
      language: 'Tamil',
      mood: 'happy',
      energy: 0.5,
    });
    const stranger = scoreTrack(p, {
      singers: ['Unknown Singer'],
      genre: 'Classical',
      language: 'Hindi',
      mood: 'sad',
      energy: 0.9,
    });
    expect(mine.score).toBeGreaterThan(stranger.score);
    expect(mine.reasons.length).toBeGreaterThan(0);
    expect(mine.reasons.join(' ')).toContain('Anirudh');
  });

  it('returns an empty neutral profile with no history', () => {
    const p = buildTasteProfile([], NOW);
    expect(p.singers).toEqual([]);
    expect(p.trackCount).toBe(0);
    expect(isUsableTaste(p)).toBe(false);
    // No affinities exist, so an unknown singer scores nothing on identity;
    // only the neutral-energy closeness applies (cold-start fallback).
    const s = scoreTrack(p, { singers: ['X'], energy: 0.5 });
    expect(s.score).toBe(1);
    expect(s.reasons).toEqual(['Matches your energy']);
  });

  it('turns repeated skips into learned dislikes that sink matches', () => {
    const signals = [
      sig({ singers: ['Fast Artist'], genre: 'Fast', eventType: 'skip', playedAt: NOW }),
      sig({ singers: ['Fast Artist'], genre: 'Fast', eventType: 'skip', playedAt: NOW - DAY }),
      sig({ singers: ['Fast Artist'], eventType: 'skip', playedAt: NOW - 2 * DAY }),
      sig({ singers: ['Melody Artist'], completed: true }),
    ];
    const p = buildTasteProfile(signals, NOW);
    expect(p.dislikes.singers.map((d) => d.name)).toContain('fast artist');
    expect(p.dislikes.genres.map((d) => d.name)).toContain('fast');
    expect(p.dislikeWeight).toBeGreaterThan(0);

    const skipped = scoreTrack(p, { singers: ['Fast Artist'], genre: 'Fast', energy: 0.5 });
    const enjoyed = scoreTrack(p, { singers: ['Melody Artist'], energy: 0.5 });
    // Raw score may go negative (the feed scorer clamps at packaging) —
    // what matters is a skip-learned match ranks below an enjoyed one.
    expect(skipped.score).toBeLessThan(enjoyed.score);
    expect(skipped.score).toBeLessThan(0);
  });

  it('weighs an explicit like above a single full listen', () => {
    const p = buildTasteProfile(
      [
        sig({ singers: ['Album Artist'], completed: true }),
        sig({ singers: ['Loved Artist'], strength: 2.5, playedAt: NOW }),
      ],
      NOW,
    );
    expect(p.singers[0].name).toBe('loved artist');
  });

  it('keeps an active artist follow influential even when old (decay floor)', () => {
    const p = buildTasteProfile(
      [
        sig({ singers: ['Old Follow'], strength: 3, floor: 1.2, playedAt: NOW - 400 * DAY }),
        sig({ singers: ['Fresh Play'], completed: true, playedAt: NOW }),
      ],
      NOW,
    );
    expect(p.singers.find((s) => s.name === 'old follow')?.affinity).toBeGreaterThan(0);
    // Floor keeps the follow ≥ a fresh single play (1.2 vs 1.0 decayed).
    expect(p.singers[0].name).toBe('old follow');
  });

  it('learns the era dimension and reasons about it', () => {
    const p = buildTasteProfile([sig({ era: '1980s' }), sig({ era: '1980s' })], NOW);
    expect(p.eras[0]).toEqual({ name: '1980s', affinity: 1 });
    const s = scoreTrack(p, { singers: ['Nobody'], era: '1980s', energy: 0.5 });
    expect(s.reasons.some((r) => r.includes('1980s'))).toBe(true);
    const other = scoreTrack(p, { singers: ['Nobody'], era: '2020s', energy: 0.5 });
    expect(other.score).toBeLessThan(s.score);
  });

  it('treats a dislikes-only profile as usable', () => {
    const p = buildTasteProfile([sig({ singers: ['Hated'], eventType: 'skip' })], NOW);
    expect(p.totalWeight).toBe(0);
    expect(isUsableTaste(p)).toBe(true);
    expect(isUsableTaste(buildTasteProfile([], NOW))).toBe(false);
    expect(isUsableTaste(null)).toBe(false);
  });

  it('splits artist strings into individual singers', () => {
    expect(splitArtists('Ilaiyaraaja, SPB & KS Chithra')).toEqual([
      'Ilaiyaraaja',
      'SPB',
      'KS Chithra',
    ]);
    expect(splitArtists('')).toEqual([]);
    expect(splitArtists(null)).toEqual([]);
  });
});

describe('history ingestion sanitizers', () => {
  it('accepts external ids with a metadata snapshot', () => {
    const row = sanitizeHistoryEvent('u1', {
      trackId: 'dQw4w9WgXcQ',
      title: 'Song Title',
      artist: 'Artist Name',
      mood: ['chill', 'calm'],
      language: 'Tamil',
      era: '1990s',
      position: 42,
      duration: 200,
      eventType: 'complete',
    });
    expect(row).not.toBeNull();
    expect(row!.trackId).toBe('dQw4w9WgXcQ');
    expect(row!.mood).toBe('chill');
    expect(row!.language).toBe('Tamil');
    expect(row!.completed).toBe(true);
    expect(row!.eventType).toBe('complete');
  });

  it('rejects unusable events and whitelists event types', () => {
    expect(sanitizeHistoryEvent('u1', { trackId: 'x', title: '' })).toBeNull();
    expect(sanitizeHistoryEvent('u1', { trackId: '', title: 'T' })).toBeNull();
    const row = sanitizeHistoryEvent('u1', {
      trackId: 'x',
      title: 'T',
      eventType: 'rm- rf /',
      position: -5,
      duration: 999999999,
    });
    expect(row!.eventType).toBe('play');
    expect(row!.position).toBe(0);
    expect(row!.duration).toBeLessThanOrEqual(86400);
  });

  it('sanitizes search queries: trims, dedupes, caps at 10', () => {
    const qs = sanitizeSearchQueries([
      '  Ilaiyaraaja  old songs ',
      'ilaiyaraaja old songs',
      42,
      'a'.repeat(300),
      ...Array.from({ length: 20 }, (_, i) => `query ${i}`),
    ]);
    expect(qs.length).toBeLessThanOrEqual(10);
    expect(qs[0]).toBe('Ilaiyaraaja old songs');
    expect(new Set(qs.map((q) => q.toLowerCase())).size).toBe(qs.length);
    expect(sanitizeSearchQueries('nope')).toEqual([]);
  });
});
