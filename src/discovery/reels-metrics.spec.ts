import { describe, expect, it } from 'vitest';
import { computeReelMetrics } from './reels-metrics';

describe('computeReelMetrics', () => {
  it('returns zeros on empty windows', () => {
    const m = computeReelMetrics([], []);
    expect(m.counts.impressions).toBe(0);
    expect(m.rates.completionRate).toBe(0);
    expect(m.rates.artistDiversity).toBe(0);
    expect(m.averages.playDwellMs).toBe(0);
  });

  it('counts event types and rates', () => {
    const m = computeReelMetrics(
      [
        { eventType: 'impression', artist: 'A', trackId: 't1' },
        { eventType: 'play', artist: 'A', trackId: 't1', dwellMs: 10000 },
        { eventType: 'play', artist: 'B', trackId: 't2', dwellMs: 1000 },
        { eventType: 'skip', artist: 'C', trackId: 't3' },
        { eventType: 'like', artist: 'A', trackId: 't1' },
        { eventType: 'share', artist: 'A', trackId: 't1' },
        { eventType: 'not_interested', artist: 'D', trackId: 't4', discovery: true },
        { eventType: 'queue', artist: 'A', trackId: 't1' },
      ],
      [
        { eventType: 'complete', position: 200, duration: 200, artist: 'A' },
        { eventType: 'skip', position: 30, duration: 200, artist: 'B' },
      ],
    );
    expect(m.counts).toMatchObject({
      impressions: 1,
      plays: 2,
      skips: 1,
      likes: 1,
      shares: 1,
      notInterested: 1,
      queues: 1,
    });
    // 1 of 2 plays ≥3s
    expect(m.meaningfulPlays).toBe(1);
    expect(m.rates.meaningfulPlayRate).toBeCloseTo(0.5, 5);
    // 1 complete / (1 complete + 1 skip)
    expect(m.rates.completionRate).toBeCloseTo(0.5, 5);
    // 1 skip / (2 plays + 1 skip) — rates are 3-decimal rounded
    expect(m.rates.skipRate).toBe(0.333);
    expect(m.rates.likeRate).toBeCloseTo(0.5, 5);
    // plays: A, B → 2 distinct / 2
    expect(m.rates.artistDiversity).toBeCloseTo(1, 5);
    // t1,t2 unique → 0 repeats
    expect(m.rates.repeatTrackRate).toBe(0);
    // 1 discovery / 8 events
    expect(m.rates.discoveryShare).toBeCloseTo(0.125, 5);
    expect(m.averages.playDwellMs).toBe(5500); // (10000+1000)/2
  });

  it('measures repeat-track rate across plays', () => {
    const m = computeReelMetrics(
      [
        { eventType: 'play', trackId: 'x', artist: 'A', dwellMs: 5000 },
        { eventType: 'play', trackId: 'x', artist: 'A', dwellMs: 5000 },
        { eventType: 'play', trackId: 'y', artist: 'B', dwellMs: 5000 },
      ],
      [],
    );
    expect(m.rates.repeatTrackRate).toBe(0.333);
    // A twice + B once → 2/3 (3-decimal rounded)
    expect(m.rates.artistDiversity).toBe(0.667);
  });

  it('ignores unknown event types and skips non-positive dwell readings', () => {
    const m = computeReelMetrics(
      [
        { eventType: 'mystery' as any, trackId: 'z', artist: 'Z', dwellMs: 9999 },
        { eventType: 'play', trackId: 'z', artist: 'Z', dwellMs: 0 },
      ],
      [],
    );
    expect(m.window.reelEvents).toBe(2);
    expect(m.counts.plays).toBe(1);
    expect(m.meaningfulPlays).toBe(0);
    expect(m.averages.playDwellMs).toBe(0); // no positive dwell reading
  });
});
