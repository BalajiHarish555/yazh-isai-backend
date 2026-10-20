/**
 * Reels recommendation observability — pure aggregation over recorded
 * events, no ML and no catalogue access. Answers "is the feed working?"
 * with the outcomes that matter (meaningful listening, completions,
 * skips, likes/saves, repetition, artist diversity, discovery uptake)
 * rather than raw session length.
 */

export interface ReelMetricEvent {
  eventType: string;
  dwellMs?: number;
  artist?: string | null;
  trackId?: string | null;
  discovery?: boolean;
}

export interface HistoryMetricEvent {
  eventType: string;
  position?: number;
  duration?: number;
  artist?: string | null;
}

export interface ReelMetrics {
  window: { reelEvents: number; historyEvents: number };
  counts: {
    impressions: number;
    plays: number;
    skips: number;
    likes: number;
    unlikes: number;
    notInterested: number;
    shares: number;
    queues: number;
  };
  /** play events held ≥3s — a play the user chose to stay with. */
  meaningfulPlays: number;
  rates: {
    /** meaningful plays / plays (plays>0 else 0). */
    meaningfulPlayRate: number;
    /** history completes / (completes + skips), 0 when no outcomes. */
    completionRate: number;
    /** skips / (plays + skips), 0 when no plays. */
    skipRate: number;
    /** (likes + unlikes inverse net) / plays. */
    likeRate: number;
    /** distinct artists / plays — 1 = never two tracks by one artist. */
    artistDiversity: number;
    /** share of plays whose track had already been played in the window. */
    repeatTrackRate: number;
    /** discovery-bucket events / all events — exploration uptake. */
    discoveryShare: number;
  };
  averages: {
    /** mean dwell over play events that carried a dwell reading. */
    playDwellMs: number;
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const ratio = (a: number, b: number) => (b > 0 ? round3(a / b) : 0);

export function computeReelMetrics(
  reelEvents: ReelMetricEvent[],
  historyEvents: HistoryMetricEvent[],
): ReelMetrics {
  const counts = {
    impressions: 0,
    plays: 0,
    skips: 0,
    likes: 0,
    unlikes: 0,
    notInterested: 0,
    shares: 0,
    queues: 0,
  };
  let meaningfulPlays = 0;
  let dwellSum = 0;
  let dwellN = 0;
  let discoveryEvents = 0;
  const playedIds: string[] = [];
  const playedArtists: string[] = [];

  for (const e of reelEvents || []) {
    switch (e.eventType) {
      case 'impression':
        counts.impressions++;
        break;
      case 'play': {
        counts.plays++;
        const dwell = Number(e.dwellMs) || 0;
        if (dwell >= 3000) meaningfulPlays++;
        if (Number.isFinite(dwell) && dwell > 0) {
          dwellSum += dwell;
          dwellN++;
        }
        if (e.trackId) playedIds.push(e.trackId);
        const artist = (e.artist || '').trim().toLowerCase();
        if (artist) playedArtists.push(artist);
        break;
      }
      case 'skip':
        counts.skips++;
        if (e.trackId) playedIds.push(e.trackId);
        break;
      case 'like':
        counts.likes++;
        break;
      case 'unlike':
        counts.unlikes++;
        break;
      case 'not_interested':
        counts.notInterested++;
        break;
      case 'share':
        counts.shares++;
        break;
      case 'queue':
        counts.queues++;
        break;
      default:
        break;
    }
    if (e.discovery === true) discoveryEvents++;
  }

  // Repeat rate: fraction of plays (by id) that hit an earlier play.
  let repeats = 0;
  const seen = new Set<string>();
  for (const id of playedIds) {
    if (seen.has(id)) repeats++;
    else seen.add(id);
  }

  // Artist diversity over plays: distinct / total (1 = maximally diverse).
  const distinctArtists = new Set(playedArtists).size;

  let completes = 0;
  let historySkips = 0;
  for (const h of historyEvents || []) {
    if (h.eventType === 'complete') completes++;
    else if (h.eventType === 'skip') historySkips++;
  }

  return {
    window: {
      reelEvents: (reelEvents || []).length,
      historyEvents: (historyEvents || []).length,
    },
    counts,
    meaningfulPlays,
    rates: {
      meaningfulPlayRate: ratio(meaningfulPlays, counts.plays),
      completionRate: ratio(completes, completes + historySkips),
      skipRate: ratio(counts.skips, counts.plays + counts.skips),
      likeRate: ratio(counts.likes, counts.plays),
      artistDiversity: ratio(distinctArtists, playedArtists.length),
      repeatTrackRate: ratio(repeats, playedIds.length),
      discoveryShare: ratio(discoveryEvents, (reelEvents || []).length),
    },
    averages: {
      playDwellMs: dwellN > 0 ? Math.round(dwellSum / dwellN) : 0,
    },
  };
}
