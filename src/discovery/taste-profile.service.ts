import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Listener-taste engine: learns what a user *actually keeps listening to*
 * from their play history and scores catalog tracks against that profile.
 *
 * Dimensions: singers, composers (album artist), genres, languages, moods
 * and energy level. Plays are weighted by completion (a skip counts less
 * than a full listen) and decayed by age (last week matters more than
 * last year). Every score ships with human reasons ("More from Anirudh")
 * so clients can show *why* a song was suggested.
 */

export interface PlaySignal {
  genre?: string | null;
  language?: string | null;
  singers: string[];
  composer?: string | null;
  mood?: string | null;
  energy: number;
  completed: boolean;
  position: number;
  duration: number;
  playedAt: number;
}

export interface Affinity {
  name: string;
  affinity: number;
}

export interface TasteProfile {
  genres: Affinity[];
  languages: Affinity[];
  singers: Affinity[];
  composers: Affinity[];
  moods: Affinity[];
  energy: number;
  totalWeight: number;
  trackCount: number;
}

export interface ScoredTrack {
  score: number;
  reasons: string[];
}

const norm = (s: unknown): string =>
  typeof s === 'string' ? s.trim().toLowerCase() : '';

function playWeight(p: PlaySignal, now: number): number {
  const base = p.completed
    ? 1
    : p.duration > 0
      ? Math.max(0.2, Math.min(0.9, p.position / p.duration))
      : 0.5;
  const daysOld = Math.max(0, (now - p.playedAt) / 86400000);
  return base * (1 / (1 + daysOld / 7));
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

export function buildTasteProfile(signals: PlaySignal[], now = Date.now()): TasteProfile {
  const genres = new Map<string, number>();
  const languages = new Map<string, number>();
  const singers = new Map<string, number>();
  const composers = new Map<string, number>();
  const moods = new Map<string, number>();
  let energySum = 0;
  let totalWeight = 0;

  for (const p of signals) {
    const w = playWeight(p, now);
    if (w <= 0) continue;
    totalWeight += w;
    const g = norm(p.genre);
    if (g) genres.set(g, (genres.get(g) || 0) + w);
    const l = norm(p.language);
    if (l) languages.set(l, (languages.get(l) || 0) + w);
    for (const s of p.singers.map(norm).filter(Boolean)) {
      singers.set(s, (singers.get(s) || 0) + w);
    }
    const c = norm(p.composer);
    if (c) composers.set(c, (composers.get(c) || 0) + w);
    const m = norm(p.mood);
    if (m) moods.set(m, (moods.get(m) || 0) + w);
    if (Number.isFinite(p.energy)) energySum += p.energy * w;
  }

  return {
    genres: top(genres, 5),
    languages: top(languages, 5),
    singers: top(singers, 8),
    composers: top(composers, 5),
    moods: top(moods, 5),
    energy: totalWeight > 0 ? Math.round((energySum / totalWeight) * 100) / 100 : 0.5,
    totalWeight: Math.round(totalWeight * 100) / 100,
    trackCount: signals.length,
  };
}

export interface ScorableTrack {
  genre?: string | null;
  language?: string | null;
  singers: string[];
  composer?: string | null;
  mood?: string | null;
  energy: number;
}

const displayCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function scoreTrack(profile: TasteProfile, track: ScorableTrack): ScoredTrack {
  const find = (list: Affinity[], name: string): number => {
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
    reasons.push({ text: `Composed in your style`, w: 1.5 * c });
  }
  const m = find(profile.moods, track.mood || '');
  if (m > 0) {
    score += 1.2 * m;
    reasons.push({ text: `${displayCase(norm(track.mood))} mood`, w: 1.2 * m });
  }
  if (Number.isFinite(track.energy)) {
    const closeness = Math.max(0, 1 - Math.abs(track.energy - profile.energy));
    if (closeness > 0.5) {
      score += closeness;
      reasons.push({ text: 'Matches your energy', w: closeness });
    }
  }

  reasons.sort((a, b) => b.w - a.w);
  return {
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 2).map((r) => r.text),
  };
}

@Injectable()
export class TasteProfileService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getTasteForUser(userId: string, limit = 20) {
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(30, Math.floor(Number(limit)))) : 20;

    const events = await this.prisma.listeningEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: {
        track: {
          include: {
            artists: { include: { artist: true } },
            album: { include: { artist: true } },
          },
        },
      },
    });

    const signals: PlaySignal[] = (events || [])
      .filter((e: any) => e?.track)
      .map((e: any) => ({
        genre: e.track.genre || undefined,
        language: e.track.language || undefined,
        singers: (e.track.artists || []).map((a: any) => a?.artist?.name).filter(Boolean),
        composer: e.track.album?.artist?.name || undefined,
        mood: e.track.mood || undefined,
        energy: typeof e.track.energy === 'number' ? e.track.energy : 0.5,
        completed: e.completed === true,
        position: typeof e.position === 'number' ? e.position : 0,
        duration: typeof e.duration === 'number' ? e.duration : 0,
        playedAt: new Date(e.createdAt).getTime(),
      }));

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
          energy: typeof t.energy === 'number' ? t.energy : 0.5,
        });
        return { ...t, score, reasons };
      })
      .filter((t: any) => t.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, n);

    return { profile, recommendations: ranked };
  }
}
