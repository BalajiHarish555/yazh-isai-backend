import { Injectable } from '@nestjs/common';
import { ReelSessionContext } from './reels-scorer';

/**
 * In-memory listening-session store — the "flow" layer of the feed.
 *
 * Tracks what the user has already played/loved/skipped in the current
 * session so the next request adapts smoothly (session appetite, singer
 * completions/skips, mood continuity, repeat penalty) without touching the
 * database. Anonymous callers simply have no session.
 *
 * Entries expire after SESSION_TTL_MS of inactivity; the map is bounded so
 * a long-lived process cannot grow without limit.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; //30 minutes of inactivity
const MAX_EVENTS = 40; // per user — recent window that shapes the feed
const MAX_USERS = 2000;

export const APPETITE_DEFAULT = 0.15;
export const APPETITE_MIN = 0.1;
export const APPETITE_MAX = 0.3;

interface SessionEvent {
  at: number;
  type: string;
  artist: string;
  titleNorm: string;
  mood: string;
  discovery: boolean;
  dwellMs: number;
}

interface UserSession {
  events: SessionEvent[]; // newest first
  appetite: number; // exploration appetite0.10..0.30
}

const normalizeTitle = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0B80-\u0BFF ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

@Injectable()
export class ReelSessionService {
  private readonly store = new Map<string, UserSession>();

  /**
   * Fold a recorded reel event into the session. Discovery events steer
   * the exploration appetite (completes/likes raise it, skips sink it);
   * every event feeds the played/singer/mood context used by the scorer.
   */
  record(
    userId: string,
    e: {
      eventType: string;
      artist?: string | null;
      title?: string | null;
      mood?: string | null;
      discovery?: boolean;
      dwellMs?: number;
    },
  ): void {
    if (!userId) return;
    const now = Date.now();
    const entry = this.store.get(userId) || { events: [], appetite: APPETITE_DEFAULT };
    this.prune(entry, now);

    const dwell = typeof e.dwellMs === 'number' && Number.isFinite(e.dwellMs) ? Math.max(0, e.dwellMs) : 0;
    const strongPlay = e.eventType === 'complete' || (e.eventType === 'play' && dwell >= 3000);

    if (e.discovery) {
      if (e.eventType === 'like') entry.appetite += 0.04;
      else if (e.eventType === 'complete') entry.appetite += 0.03;
      else if (strongPlay) entry.appetite += 0.01;
      else if (e.eventType === 'skip') entry.appetite -= 0.03;
      else if (e.eventType === 'not_interested') entry.appetite -= 0.04;
      entry.appetite = Math.min(APPETITE_MAX, Math.max(APPETITE_MIN, entry.appetite));
    }

    entry.events.unshift({
      at: now,
      type: e.eventType,
      artist: (e.artist || '').trim().toLowerCase(),
      titleNorm: normalizeTitle(e.title || ''),
      mood: (e.mood || '').trim().toLowerCase(),
      discovery: !!e.discovery,
      dwellMs: dwell,
    });
    if (entry.events.length > MAX_EVENTS) entry.events.length = MAX_EVENTS;

    this.store.set(userId, entry);
    if (this.store.size > MAX_USERS) {
      // Evict the oldest-updated key (Map preserves insertion order).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined && oldest !== userId) this.store.delete(oldest);
    }
  }

  /** Drop a user's live session (recommendation reset / logout hygiene). */
  clear(userId: string): void {
    if (!userId) return;
    this.store.delete(userId);
  }

  /** Snapshot for the scorer; null when there is no live session. */
  context(userId: string): { appetite: number; session: ReelSessionContext } | null {
    if (!userId) return null;
    const entry = this.store.get(userId);
    if (!entry) return null;
    this.prune(entry, Date.now());
    if (entry.events.length === 0) return null;

    const playedTitles: string[] = [];
    const singerCompletions: Record<string, number> = {};
    const singerSkips: Record<string, number> = {};
    const moodCompletions: Record<string, number> = {};
    const seenTitle = new Set<string>();

    for (const e of entry.events) {
      const strongPlay = e.type === 'complete' || (e.type === 'play' && e.dwellMs >= 3000);
      if (
        (e.type === 'play' ||
          e.type === 'complete' ||
          e.type === 'replay' ||
          e.type === 'queue' ||
          e.type === 'skip') &&
        e.titleNorm &&
        !seenTitle.has(e.titleNorm)
      ) {
        seenTitle.add(e.titleNorm);
        playedTitles.push(e.titleNorm);
      }
      if (strongPlay) {
        if (e.artist) singerCompletions[e.artist] = (singerCompletions[e.artist] || 0) + 1;
        if (e.mood) moodCompletions[e.mood] = (moodCompletions[e.mood] || 0) + 1;
      } else if ((e.type === 'skip' || e.type === 'not_interested') && e.artist) {
        singerSkips[e.artist] = (singerSkips[e.artist] || 0) + 1;
      }
    }

    return {
      appetite: entry.appetite,
      session: { playedTitles, singerCompletions, singerSkips, moodCompletions },
    };
  }

  /** Drop expired sessions (and the user key once empty). */
  private prune(entry: UserSession, now: number): void {
    const cutoff = now - SESSION_TTL_MS;
    while (entry.events.length > 0 && entry.events[entry.events.length - 1].at < cutoff) {
      entry.events.pop();
    }
    if (entry.events.length === 0) {
      for (const [k, v] of this.store) {
        if (v === entry) {
          this.store.delete(k);
          break;
        }
      }
    }
  }
}
