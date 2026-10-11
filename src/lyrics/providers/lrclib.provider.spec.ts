import { describe, expect, it } from 'vitest';
import { LrcLibLyricsProvider } from './lrclib.provider';

describe('LrcLibLyricsProvider (pure logic, no network)', () => {
  const provider = new LrcLibLyricsProvider();

  it('strips LRC timestamps, keeps text', () => {
    const out = (provider as any).stripTimestamps('[00:00.42] Is this the real life?\n[00:04.03] Is this just fantasy?');
    expect(out).toBe('Is this the real life?\nIs this just fantasy?');
  });

  it('scores exact matches highest', () => {
    const score = (item: any, a: string, t: string) => (provider as any).scoreMatch(item, a, t);
    const exact = score({ artistName: 'Queen', trackName: 'Bohemian Rhapsody' }, 'Queen', 'Bohemian Rhapsody');
    const partial = score({ artistName: 'Queens', trackName: 'Bohemian' }, 'Queen', 'Bohemian Rhapsody');
    const wrong = score({ artistName: 'Abba', trackName: 'Dancing Queen' }, 'Queen', 'Bohemian Rhapsody');
    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(wrong);
  });

  it('penalizes instrumentals and lyric-less entries', () => {
    const score = (item: any) => (provider as any).scoreMatch(item, 'Queen', 'Bohemian Rhapsody');
    const withLyrics = score({ artistName: 'Queen', trackName: 'Bohemian Rhapsody', plainLyrics: 'x' });
    const instrumental = score({ artistName: 'Queen', trackName: 'Bohemian Rhapsody', instrumental: true, plainLyrics: 'x' });
    expect(withLyrics).toBeGreaterThan(instrumental);
  });
});
