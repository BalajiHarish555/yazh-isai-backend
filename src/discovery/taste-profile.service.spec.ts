import { describe, expect, it } from 'vitest';
import { buildTasteProfile, scoreTrack, PlaySignal } from './taste-profile.service';

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
    // No affinities exist, so an unknown singer scores nothing on identity;
    // only the neutral-energy closeness applies (cold-start fallback).
    const s = scoreTrack(p, { singers: ['X'], energy: 0.5 });
    expect(s.score).toBe(1);
    expect(s.reasons).toEqual(['Matches your energy']);
  });
});
