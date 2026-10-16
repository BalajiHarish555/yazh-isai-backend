import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Listener-taste engine: learns what a user *actually keeps listening to*
 * and scores catalog/provider tracks against that profile. Rules-based —
 * no ML. Signals: listening history (complete / partial / skip / replay),
 * library likes, playlist adds, artist follows and Reel feedback. Plays are
 * weighted by completion (a skip is a NEGATIVE signal), scaled by explicit
 * strengths (likes/follows outweigh a single play) and decayed by age so the
 * profile *gradually* follows the user instead of latching onto one session.
 * Every score ships with human reasons ("More from Anirudh") so clients can
 * show *why* a song was suggested.
 */

export interface PlaySignal {
  genre?: string | null;
  language?: string | null;
  singers: string[];
  composer?: string | null;
  mood?: string | null;
  era?: string | null;
  energy?: number | null;
  completed: boolean;
  position: number;
  duration: number;
  playedAt: number;
  /** Event kind: play | complete | skip | replay (skip → negative weight). */
  eventType?: string;
  /** Overrides the event-derived base weight before decay (likes/follows). */
  strength?: number;
  /** Never let the decayed weight fall below this floor (active follows). */
  floor?: number;
}

export interface Affinity {
  name: string;
  affinity: number;
}

export interface TasteDislikes {
  singers: Affinity[];
  genres: Affinity[];
  languages: Affinity[];
  moods: Affinity[];
  eras: Affinity[];
}

export interface TasteProfile {
  genres: Affinity[];
  languages: Affinity[];
  singers: Affinity[];
  composers: Affinity[];
  moods: Affinity[];
  eras: Affinity[];
  dislikes: TasteDislikes;
  energy: number;
  totalWeight: number;
  dislikeWeight: number;
  trackCount: number;
}

export interface ScoredTrack {
  score: number;
  reasons: string[];
}

const norm = (s: unknown): string =>
  typeof s === 'string' ? s.trim().toLowerCase() : '';

/** Split artist strings like "Ilaiyaraaja, SPB" / "A & B" into names. */
export function splitArtists(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,/&]| and /i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 80);
}

function playWeight(p: PlaySignal, now: number): number {
  let base: number;
  if (typeof p.strength === 'number' && Number.isFinite(p.strength)) {
    base = p.strength;
  } else if (p.eventType === 'skip') {
    base = -0.8;
  } else if (p.eventType === 'replay') {
    base = 1.4;
  } else if (p.eventType === 'save') {
    base = 2; // explicit "keep this" intent — stronger than a play
  } else if (p.eventType === 'artist_view') {
    base = 0.5; // curiosity signal, weakest positive
  } else if (p.completed || p.eventType === 'complete') {
    base = 1;
  } else if (p.duration > 0) {
    base = Math.max(0.2, Math.min(0.9, p.position / p.duration));
  } else {
    base = 0.5;
  }
  const daysOld = Math.max(0, (now - p.playedAt) / 86400000);
  const decayed = base * (1 / (1 + daysOld / 7));
  return typeof p.floor === 'number' && Number.isFinite(p.floor)
    ? Math.max(p.floor, decayed)
    : decayed;
}

function top(counter: Map<string, number>, n: number): Affinity[] {
  let max = 0;
  for (const v of counter.values()) max = Math.max(max, v);
  if (max <= 0) return [];
  return [...counter.entries()]
    .map(([name, w]) => ({ name, affinity: Math.round((w / max) * 100) / 100 }))
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, n);
}

/** Magnitudes of the negative-only counters, normalized 0..1. */
function topNegative(counter: Map<string, number>, n: number): Affinity[] {
  let max = 0;
  for (const v of counter.values()) max = Math.max(max, Math.abs(v));
  if (max <= 0) return [];
  return [...counter.entries()]
    .filter(([, w]) => w < 0)
    .map(([name, w]) => ({ name, affinity: Math.round((Math.abs(w) / max) * 100) / 100 }))
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, n);
}

function bump(pos: Map<string, number>, neg: Map<string, number>, key: string, w: number) {
  if (!key) return;
  pos.set(key, (pos.get(key) || 0) + w);
  neg.set(key, (neg.get(key) || 0) + w);
}

export function buildTasteProfile(signals: PlaySignal[], now = Date.now()): TasteProfile {
  const genres = new Map<string, number>();
  const languages = new Map<string, number>();
  const singers = new Map<string, number>();
  const composers = new Map<string, number>();
  const moods = new Map<string, number>();
  const eras = new Map<string, number>();
  const genreNeg = new Map<string, number>();
  const languageNeg = new Map<string, number>();
  const singerNeg = new Map<string, number>();
  const moodNeg = new Map<string, number>();
  const eraNeg = new Map<string, number>();
  let energySum = 0;
  let energyWeight = 0;
  let totalWeight = 0;
  let dislikeWeight = 0;

  for (const p of signals) {
    const w = playWeight(p, now);
    if (w === 0) continue;
    if (w > 0) totalWeight += w;
    else dislikeWeight += Math.abs(w);

    const g = norm(p.genre);
    if (g) bump(genres, genreNeg, g, w);
    const l = norm(p.language);
    if (l) bump(languages, languageNeg, l, w);
    for (const s of p.singers.map(norm).filter(Boolean)) {
      bump(singers, singerNeg, s, w);
    }
    const c = norm(p.composer);
    if (c) composers.set(c, (composers.get(c) || 0) + w);
    const m = norm(p.mood);
    if (m) bump(moods, moodNeg, m, w);
    const e = norm(p.era);
    if (e) bump(eras, eraNeg, e, w);
    if (typeof p.energy === 'number' && Number.isFinite(p.energy)) {
      energySum += p.energy * Math.abs(w);
      energyWeight += Math.abs(w);
    }
  }

  return {
    genres: top(genres, 5),
    languages: top(languages, 5),
    singers: top(singers, 8),
    composers: top(composers, 5),
    moods: top(moods, 5),
    eras: top(eras, 4),
    dislikes: {
      singers: topNegative(singerNeg, 5),
      genres: topNegative(genreNeg, 5),
      languages: topNegative(languageNeg, 3),
      moods: topNegative(moodNeg, 5),
      eras: topNegative(eraNeg, 3),
    },
    energy: energyWeight > 0 ? Math.round((energySum / energyWeight) * 100) / 100 : 0.5,
    totalWeight: Math.round(totalWeight * 100) / 100,
    dislikeWeight: Math.round(dislikeWeight * 100) / 100,
    trackCount: signals.length,
  };
}

/** A profile carries usable knowledge with either positive taste or dislikes. */
export function isUsableTaste(profile: TasteProfile | null | undefined): profile is TasteProfile {
  return !!profile && (profile.totalWeight > 0 || profile.dislikeWeight > 0);
}

export interface ScorableTrack {
  genre?: string | null;
  language?: string | null;
  singers: string[];
  composer?: string | null;
  mood?: string | null;
  era?: string | null;
  energy?: number | null;
}

const displayCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function scoreTrack(profile: TasteProfile, track: ScorableTrack): ScoredTrack {
  const find = (list: Affinity[] | undefined, name: string): number => {
    if (!Array.isArray(list)) return 0;
    const hit = list.find((a) => a.name === norm(name));
    return hit ? hit.affinity : 0;
  };
  let score = 0;
  const reasons: Array<{ text: string; w: number }> = [];

  const g = find(profile.genres, track.genre || '');
  if (g > 0) {
    score += 2.2 * g;
    reasons.push({ text: `${displayCase(norm(track.genre))} vibes`, w: 2.2 * g });
  }
  const l = find(profile.languages, track.language || '');
  if (l > 0) {
    score += 1.6 * l;
    reasons.push({ text: `In ${displayCase(norm(track.language))}`, w: 1.6 * l });
  }
  let bestSinger = 0;
  let bestSingerName = '';
  for (const s of track.singers) {
    const a = find(profile.singers, s);
    if (a > bestSinger) {
      bestSinger = a;
      bestSingerName = s;
    }
  }
  if (bestSinger > 0) {
    score += 2.8 * bestSinger;
    reasons.push({ text: `More from ${displayCase(bestSingerName)}`, w: 2.8 * bestSinger });
  }
  const c = find(profile.composers, track.composer || '');
  if (c > 0) {
    score += 1.5 * c;
    reasons.push({ text: 'Composed in your style', w: 1.5 * c });
  }
  const m = find(profile.moods, track.mood || '');
  if (m > 0) {
    score += 1.2 * m;
    reasons.push({ text: `${displayCase(norm(track.mood))} mood`, w: 1.2 * m });
  }
  const era = find(profile.eras, track.era || '');
  if (era > 0) {
    score += 1.2 * era;
    reasons.push({ text: `${displayCase(norm(track.era))} era`, w: 1.2 * era });
  }
  if (typeof track.energy === 'number' && Number.isFinite(track.energy)) {
    const closeness = Math.max(0, 1 - Math.abs(track.energy - profile.energy));
    if (closeness > 0.5) {
      score += closeness;
      reasons.push({ text: 'Matches your energy', w: closeness });
    }
  }

  // Learned dislikes (repeated skips / not-interested) push a track down
  // without ever hard-hiding it — the feed still decides what survives.
  const d = profile.dislikes || { singers: [], genres: [], languages: [], moods: [], eras: [] };
  const punish = (list: Affinity[], name: string, factor: number, text: string) => {
    const hit = find(list, name);
    if (hit > 0) {
      score -= factor * hit;
      if (hit >= 0.5) reasons.push({ text, w: -factor * hit });
    }
  };
  let worstSinger = 0;
  for (const s of track.singers) worstSinger = Math.max(worstSinger, find(d.singers, s));
  if (worstSinger > 0) {
    score -= 1.6 * worstSinger;
    if (worstSinger >= 0.5) reasons.push({ text: 'You often skip this artist', w: -1.6 * worstSinger });
  }
  punish(d.genres, track.genre || '', 1.2, 'Not your usual vibe');
  punish(d.moods, track.mood || '', 1.0, 'You skipped this mood');
  punish(d.eras, track.era || '', 1.0, 'You skipped this era');
  punish(d.languages, track.language || '', 0.8, 'You skipped this language');

  const positive = reasons.filter((r) => r.w > 0).sort((a, b) => b.w - a.w);
  return {
    score: Math.round(score * 100) / 100,
    reasons: positive.slice(0, 2).map((r) => r.text),
  };
}

const HISTORY_RETENTION_DAYS = 180;

function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
}

@Injectable()
export class TasteProfileService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  /**
   * All learned signals for a user, newest first:
   * - listening history snapshots (external sources included)
   * - library likes + playlist adds (local-first JSON snapshot)
   * - DB liked rows / artist follows
   * - reel play/skip/like feedback (same algorithm learns from Reels)
   */
  private async loadSignals(userId: string): Promise<{ events: any[]; signals: PlaySignal[] }> {
    const [events, user, profileRow, followed, likedRows] = await Promise.all([
      this.prisma.listeningEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 400,
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { preferences: true },
      }),
      this.prisma.profile.findUnique({ where: { userId }, select: { library: true } }),
      this.prisma.followedArtist.findMany({
        where: { userId },
        include: { artist: true },
        take: 50,
      }),
      this.prisma.likedTrack.findMany({
        where: { userId },
        include: {
          track: {
            include: { artists: { include: { artist: true } }, album: { include: { artist: true } } },
          },
        },
        take: 200,
      }),
    ]);

    const now = Date.now();
    const signals: PlaySignal[] = [];

    // 1. Listening history — snapshot fields, negative weights for skips.
    for (const e of events || []) {
      const eventType = typeof e.eventType === 'string' ? e.eventType : 'play';
      if (eventType !== 'skip' && !str(e.title)) continue;
      signals.push({
        genre: e.genre || undefined,
        language: e.language || undefined,
        singers: splitArtists(e.artist),
        composer: e.composer || undefined,
        mood: e.mood || undefined,
        era: e.era || undefined,
        energy: null,
        completed: e.completed === true,
        position: typeof e.position === 'number' ? e.position : 0,
        duration: typeof e.duration === 'number' ? e.duration : 0,
        playedAt: new Date(e.createdAt).getTime(),
        eventType,
      });
    }

    // 2. Artist follows — durable intent with a decay floor while active.
    for (const f of followed || []) {
      const name = str(f.artist?.name, 80);
      if (!name) continue;
      signals.push({
        singers: [name],
        completed: true,
        position: 1,
        duration: 1,
        playedAt: new Date(f.createdAt || now).getTime(),
        strength: 3,
        floor: 1.2,
      });
    }

    // 3. DB liked rows (catalog ids) — decayed by when the like happened.
    for (const l of likedRows || []) {
      const t: any = l.track;
      if (!t) continue;
      signals.push({
        genre: t.genre || undefined,
        language: t.language || undefined,
        singers: (t.artists || []).map((a: any) => a?.artist?.name).filter(Boolean),
        composer: t.album?.artist?.name || undefined,
        mood: t.mood || undefined,
        era: t.era || undefined,
        energy: typeof t.energy === 'number' ? t.energy : null,
        completed: true,
        position: 1,
        duration: 1,
        playedAt: new Date(l.createdAt || now).getTime(),
        strength: 2.5,
      });
    }

    // 4. Local-first library snapshot: likes (unknown age → treated as
    //    current) and playlist adds (aged by playlist creation).
    const lib = this.parseLibrary(profileRow?.library ?? null);
    for (const song of lib.liked.slice(0, 150)) {
      const singers = splitArtists((song as any)?.artist);
      if (singers.length === 0) continue;
      signals.push({
        singers,
        completed: true,
        position: 1,
        duration: 1,
        playedAt: now,
        strength: 2.5,
      });
    }
    for (const pl of lib.playlists.slice(0, 20)) {
      const at = typeof pl.createdAt === 'number' ? pl.createdAt : now;
      for (const song of (pl.tracks || []).slice(0, 100)) {
        const singers = splitArtists((song as any)?.artist);
        if (singers.length === 0) continue;
        signals.push({
          singers,
          completed: true,
          position: 1,
          duration: 1,
          playedAt: at,
          strength: 1.2,
        });
      }
    }

    // 5. Reel feedback — plays (dwell ≥ 3s) and likes lift, skips sink.
    const reelEvents = await this.prisma.reelEvent
      .findMany({
        where: { userId, eventType: { in: ['play', 'skip', 'like'] } },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { artist: true, mood: true, eventType: true, dwellMs: true, createdAt: true },
      })
      .catch(() => []);
    for (const e of reelEvents || []) {
      const singers = splitArtists(e.artist);
      const mood = str(e.mood, 40);
      const strength =
        e.eventType === 'like' ? 2 : e.eventType === 'skip' ? -0.6 : (e.dwellMs || 0) >= 3000 ? 0.8 : 0;
      if (strength === 0) continue;
      signals.push({
        singers,
        mood,
        completed: strength > 0,
        position: 1,
        duration: 1,
        playedAt: new Date(e.createdAt).getTime(),
        strength,
      });
    }

    // Onboarding preference prior — a weak, undecayed floor so first-run
    // users get taste-led results that actual listening can outrank.
    const p = user?.preferences;
    const prior = (raw: unknown, key: 'singers' | 'moods' | 'genres' | 'languages'): void => {
      const list = this.parseJsonStringArray(raw).slice(0, 10);
      for (const name of list) {
        signals.push({
          singers: key === 'singers' ? [name] : [],
          mood: key === 'moods' ? name : undefined,
          genre: key === 'genres' ? name : undefined,
          language: key === 'languages' ? name : undefined,
          completed: true,
          position: 1,
          duration: 1,
          playedAt: now,
          strength: 0.6,
        });
      }
    };
    if (p) {
      prior(p.preferredArtists, 'singers');
      prior(p.preferredMoods, 'moods');
      prior(p.preferredGenres, 'genres');
      prior(p.preferredLanguages, 'languages');
    }

    return { events: events || [], signals };
  }

  private parseLibrary(raw: string | null): {
    liked: Array<Record<string, unknown>>;
    playlists: Array<{ createdAt?: number; tracks?: Array<Record<string, unknown>> }>;
  } {
    try {
      const lib = JSON.parse(raw || 'null');
      return {
        liked: Array.isArray(lib?.liked) ? lib.liked : [],
        playlists: Array.isArray(lib?.playlists) ? lib.playlists : [],
      };
    } catch {
      return { liked: [], playlists: [] };
    }
  }

  private parseJsonStringArray(raw: unknown): string[] {
    try {
      if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
      if (typeof raw === 'string' && raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
      }
    } catch {
      // Corrupt row — treat as empty.
    }
    return [];
  }

  /** Recent search queries (newest first) — search intent for ranking. */
  async getRecentSearchTokens(userId: string, limit = 10): Promise<string[]> {
    const n = Math.max(1, Math.min(30, Math.floor(Number(limit) || 10)));
    const rows = await this.prisma.searchIntent
      .findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: n,
        select: { query: true },
      })
      .catch(() => []);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows || []) {
      const q = (r.query || '').trim().slice(0, 120);
      const key = q.toLowerCase();
      if (!q || seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
    return out;
  }

  /**
   * Lightweight taste profile for feed ranking — no candidate scan.
   * Empty history yields an empty profile (totalWeight0) callers should skip.
   */
  async getProfileForUser(userId: string): Promise<TasteProfile> {
    const { signals } = await this.loadSignals(userId);
    return buildTasteProfile(signals);
  }

  async getTasteForUser(userId: string, limit = 20) {
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(30, Math.floor(Number(limit)))) : 20;

    const { events, signals } = await this.loadSignals(userId);

    const profile = buildTasteProfile(signals);
    if (signals.length === 0) {
      return { profile, recommendations: [] };
    }

    const heard = new Set(events.map((e: any) => e.trackId).filter(Boolean));
    const candidates = await this.prisma.track.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
      include: {
        artists: { include: { artist: true } },
        album: { include: { artist: true } },
      },
    });

    const ranked = (candidates || [])
      .filter((t: any) => !heard.has(t.id))
      .map((t: any) => {
        const { score, reasons } = scoreTrack(profile, {
          genre: t.genre,
          language: t.language,
          singers: (t.artists || []).map((a: any) => a?.artist?.name).filter(Boolean),
          composer: t.album?.artist?.name,
          mood: t.mood,
          era: t.era,
          energy: typeof t.energy === 'number' ? t.energy : null,
        });
        return { ...t, score, reasons };
      })
      .filter((t: any) => t.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, n);

    return { profile, recommendations: ranked };
  }

  /** Age-prune so history stays bounded without unbounded scans. */
  async pruneHistory(userId: string): Promise<void> {
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
    await this.prisma.listeningEvent
      .deleteMany({ where: { userId, createdAt: { lt: new Date(cutoff) } } })
      .catch(() => undefined);
  }
}

const HISTORY_ALLOWED_EVENTS = ['play', 'complete', 'skip', 'replay', 'save', 'artist_view'];

/**
 * History ingestion sanitizer (shared by the profiles endpoint): external
 * track ids are legal here — the row carries a metadata snapshot instead of
 * a catalog FK. Returns null when the event is unusable.
 */
export function sanitizeHistoryEvent(userId: string, dto: any): Record<string, any> | null {
  const trackId = typeof dto?.trackId === 'string' ? dto.trackId.trim().slice(0, 128) : '';
  const title = typeof dto?.title === 'string' ? dto.title.trim().slice(0, 200) : '';
  if (!trackId || !title) return null;
  const eventType =
    typeof dto?.eventType === 'string' && HISTORY_ALLOWED_EVENTS.includes(dto.eventType)
      ? dto.eventType
      : 'play';
  const clamp = (v: unknown, max: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
  };
  return {
    userId,
    trackId,
    title,
    artist: (typeof dto?.artist === 'string' ? dto.artist.trim().slice(0, 200) : '') || '',
    composer: str(dto?.composer, 120),
    language: str(dto?.language, 40),
    genre: str(dto?.genre, 60),
    mood: Array.isArray(dto?.mood)
      ? str((dto.mood as any[])[0], 60)
      : str(dto?.mood, 60),
    era: str(dto?.era, 40),
    source: str(dto?.source, 60),
    position: clamp(dto?.position, 86400),
    duration: clamp(dto?.duration, 86400),
    completed: eventType === 'complete' ? true : dto?.completed === true,
    eventType,
  };
}

/** Search-intent sanitizer: bounded, deduped, plain strings. */
export function sanitizeSearchQueries(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of list) {
    if (typeof q !== 'string') continue;
    const v = q.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 10) break;
  }
  return out;
}
