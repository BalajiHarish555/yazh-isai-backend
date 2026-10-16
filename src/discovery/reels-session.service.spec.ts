import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ReelSessionService } from './reels-session.service';

const user = 'user-1';

describe('ReelSessionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has no context until something is recorded', () => {
    const s = new ReelSessionService();
    expect(s.context(user)).toBeNull();
    expect(s.context('')).toBeNull();
  });

  it('defaults appetite to0.15 and only discovery events steer it', () => {
    const s = new ReelSessionService();
    s.record(user, { eventType: 'complete', title: 'T', artist: 'A' }); // not discovery → no appetite move
    expect(s.context(user)!.appetite).toBeCloseTo(0.15, 5);

    s.record(user, { eventType: 'complete', title: 'G1', artist: 'A', discovery: true });
    s.record(user, { eventType: 'like', title: 'G2', artist: 'A', discovery: true });
    const up = s.context(user)!.appetite;
    expect(up).toBeGreaterThan(0.15);

    s.record(user, { eventType: 'skip', title: 'G3', artist: 'A', discovery: true });
    s.record(user, { eventType: 'not_interested', title: 'G4', artist: 'A', discovery: true });
    const down = s.context(user)!.appetite;
    expect(down).toBeLessThan(up);
  });

  it('clamps appetite to the0.10..0.30 band', () => {
    const s = new ReelSessionService();
    for (let i = 0; i < 50; i++) {
      s.record(user, { eventType: 'like', title: `T${i}`, artist: 'A', discovery: true });
    }
    expect(s.context(user)!.appetite).toBeCloseTo(0.3, 5);
    for (let i = 0; i < 80; i++) {
      s.record(user, { eventType: 'not_interested', title: `X${i}`, artist: 'A', discovery: true });
    }
    expect(s.context(user)!.appetite).toBeCloseTo(0.1, 5);
  });

  it('aggregates played titles, singer and mood context', () => {
    const s = new ReelSessionService();
    s.record(user, { eventType: 'complete', title: 'Song A', artist: 'Loved Artist', mood: 'chill' });
    s.record(user, { eventType: 'play', title: 'Song B', artist: 'Loved Artist', dwellMs: 5000, mood: 'chill' });
    s.record(user, { eventType: 'play', title: 'Skimmed', artist: 'Loved Artist', dwellMs: 500 });
    s.record(user, { eventType: 'skip', title: 'Song C', artist: 'Skipped Artist' });
    const ctx = s.context(user)!;
    expect(ctx.session.playedTitles).toEqual(['song c', 'skimmed', 'song b', 'song a']);
    expect(ctx.session.singerCompletions).toEqual({ 'loved artist': 2 });
    expect(ctx.session.singerSkips).toEqual({ 'skipped artist': 1 });
    expect(ctx.session.moodCompletions).toEqual({ chill: 2 });
  });

  it('expires after30 minutes of inactivity', () => {
    const s = new ReelSessionService();
    s.record(user, { eventType: 'complete', title: 'Song A', artist: 'A' });
    expect(s.context(user)).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-16T12:29:00Z'));
    expect(s.context(user)).not.toBeNull(); //29min still live
    vi.setSystemTime(new Date('2026-10-16T12:31:00Z'));
    expect(s.context(user)).toBeNull(); //31min → expired
  });

  it('keeps the newest MAX_EVENTS per user', () => {
    const s = new ReelSessionService();
    for (let i = 0; i < 60; i++) {
      s.record(user, { eventType: 'play', title: `Song ${i}`, artist: 'A' });
    }
    const ctx = s.context(user)!;
    expect(ctx.session.playedTitles![0]).toBe('song 59'); // newest first
    expect(ctx.session.playedTitles!.length).toBeLessThanOrEqual(40);
  });
});
