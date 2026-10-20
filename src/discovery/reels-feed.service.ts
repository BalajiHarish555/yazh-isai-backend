import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JioSaavnService } from '../catalog/jiosaavn.service';
import { YouTubeMusicService } from '../catalog/youtube-music.service';
import { CacheService } from '../common/cache.service';
import { MoodEngineService } from './mood-engine.service';
import { TasteProfileService, isUsableTaste, splitArtists } from './taste-profile.service';
import { ReelSessionService } from './reels-session.service';
import {
  ReelBehavior,
  ReelCandidate,
  ReelFeedback,
  ReelPrefs,
  normalizeTitle,
  scoreCandidates,
  stableHash,
  ReelFeedItem,
} from './reels-scorer';
import { decodeFeedCursor, encodeFeedCursor, extendSeen } from './feed-cursor';
import { computeReelMetrics, ReelMetrics } from './reels-metrics';

/**
 * Reels feed service: gathers provider candidates (Saavn charts, mood- or
 * taste-keyed YouTube search, local catalog), loads per-user signals
 * (preferences, library likes, reel feedback, learned taste, search intent)
 * and ranks them with the deterministic reels-scorer — the SAME rules-based
 * engine backs the personalised For You home feed. Also records reel events
 * and manages mood preferences.
 */

const ALLOWED_EVENT_TYPES = new Set([
  'impression',
  'skip',
  'play',
  'like',
  'unlike',
  'not_interested',
  'undo_not_interested',
  'share',
  'queue',
  'open_player',
]);

/** Mood → YouTube search keywords (language prefix added at query time). */
const MOOD_QUERIES: Record<string, string> = {
  dreamy: 'dreamy melodic hit songs',
  energy: 'energy boost dance hit songs',
  focus: 'focus instrumental study songs',
  chill: 'chill relaxed melody songs',
  romantic: 'romantic love hit songs',
  dark: 'dark moody bass songs',
  nostalgic: 'nostalgic old classic hit songs',
  peaceful: 'peaceful calm melody songs',
};

const HISTORY_RETENTION_DAYS = 90;
const MAX_EVENTS_PER_CALL = 50;

function safeJsonArray(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    }
  } catch {
    // Corrupt preference row — treat as empty rather than 500ing the feed.
  }
  return [];
}

function sanitizeToken(raw: unknown, max = 32): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);
}

function sanitizeSeed(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : '';
  return s || 'default';
}

function sanitizeList(raw: unknown, maxItems: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const item = v.trim().slice(0, 60);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

const KNOWN_LANGS = ['tamil', 'hindi', 'telugu', 'malayalam', 'kannada', 'english'];

/** Provenance language: only tag when the query/chart itself named it. */
function inferLanguage(query: string): string | null {
  const q = (query || '').toLowerCase();
  for (const l of KNOWN_LANGS) if (q.includes(l)) return l;
  return null;
}

/** Year → decade bucket ("1992" → "1990s") for the era taste dimension. */
function eraFromYear(year: unknown): string | null {
  const n = Math.floor(Number(year));
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return null;
  return `${Math.floor(n / 10) * 10}s`;
}

@Injectable()
export class ReelsFeedService {
  private readonly logger = new Logger(ReelsFeedService.name);

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jioSaavn: JioSaavnService,
    private youtube: YouTubeMusicService,
    private moodEngine: MoodEngineService,
    private taste: TasteProfileService,
    private cache: CacheService,
    private session: ReelSessionService,
  ) {}

  async getFeed(opts: {
    mood?: string;
    lang?: string;
    limit?: number;
    seed?: string;
    userId?: string;
    /** Opaque continuation cursor from a previous page (context + seen ids). */
    cursor?: string;
  }) {
    const limitRaw = Number(opts?.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(5, Math.min(30, Math.floor(limitRaw)))
      : 20;
    // A valid cursor owns the request context (continuity); without one the
    // query params define a fresh feed. Mood switches simply omit the cursor.
    const cursor = decodeFeedCursor(opts?.cursor);
    const mood = cursor ? (cursor.mood ?? '') : sanitizeToken(opts?.mood);
    const lang = cursor ? cursor.lang : sanitizeToken(opts?.lang) || 'tamil';
    const seed = cursor ? cursor.seed : sanitizeSeed(opts?.seed);
    const page = cursor ? cursor.page : 1;
    const seenIds = new Set(cursor?.seen ?? []);
    const userId = typeof opts?.userId === 'string' ? opts.userId : '';

    const cacheKey = `reels_feed_${userId || 'anon'}_${mood}_${lang}_${seed}_${limit}_p${page}_${seenIds.size ? stableHash([...seenIds].join(',')).toString(36) : '0'}`;
    const cached = await this.cache.get<{
      seed: string;
      mood: string | null;
      lang: string;
      personalized: boolean;
      generatedAt: string;
      count: number;
      page: number;
      nextCursor: string | null;
      items: ReelFeedItem[];
    }>(cacheKey).catch(() => null);
    if (cached) return cached;

    let prefs: ReelPrefs = {};
    let feedback: ReelFeedback = {};
    let taste = null;
    let searchTokens: string[] = [];
    let behavior: ReelBehavior | null = null;
    if (userId) {
      const signals = await this.loadUserSignals(userId).catch(() => null);
      if (signals) {
        prefs = signals.prefs;
        feedback = signals.feedback;
      }
      const [profile, queries, recentEvents] = await Promise.all([
        this.taste.getProfileForUser(userId).catch(() => null),
        this.taste.getRecentSearchTokens(userId, 10).catch(() => []),
        this.prisma.listeningEvent
          .findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 60,
            select: { trackId: true, title: true, artist: true, eventType: true },
          })
          .catch(() => [] as any[]),
      ]);
      if (isUsableTaste(profile)) taste = profile;
      searchTokens = queries;
      behavior = this.buildBehavior(recentEvents as any[]);
    }

    const pool = await this.getCandidates(mood, lang, limit);
    // Familiar stock for THIS user: the shared chart pool may contain none
    // of the artists they actually know, which starves the familiar bucket
    // (and its forced first-two-slots lead). Uncached — a shared cache
    // would leak one user's artist queries into everyone's feed.
    const artistSlice = await this.getTasteArtistCandidates(taste, lang);
    const mergedPool = artistSlice.length > 0 ? [...artistSlice, ...pool] : pool;
    // Continuation pages drop everything already delivered in this session.
    const fullPool = seenIds.size
      ? mergedPool.filter((c) => !seenIds.has(c.id))
      : mergedPool;

    const sess = userId ? this.session.context(userId) : null;
    const moodTags = mood ? this.moodEngine.getParamsForMood(mood).moods : [];

    const items = scoreCandidates(fullPool, {
      seed,
      mood,
      moodTags,
      lang,
      prefs,
      taste,
      feedback,
      searchTokens,
      behavior,
      session: sess?.session ?? null,
      appetite: sess?.appetite,
      limit,
    }).slice(0, limit);

    const personalized =
      !!userId &&
      (isUsableTaste(taste) ||
        (prefs.artists || []).length > 0 ||
        (prefs.moods || []).length > 0 ||
        (feedback.likedIds || []).length > 0);

    this.logger.log(
      `Reels feed mood=${mood || 'all'} lang=${lang} pool=${fullPool.length} -> ${items.length} items (user=${userId ? 'yes' : 'no'} personalized=${personalized})`,
    );

    // Continuation only when this page came back full — a short page means
    // the eligible pool is exhausted and another request would loop.
    const nextCursor =
      items.length >= limit && items.length > 0
        ? encodeFeedCursor({
            seed,
            mood: mood || null,
            lang,
            page: page + 1,
            seen: extendSeen(
              [...seenIds],
              items.map((i) => i.id),
            ),
          })
        : null;

    const result = {
      seed,
      mood: mood || null,
      lang,
      personalized,
      generatedAt: new Date().toISOString(),
      count: items.length,
      page,
      nextCursor,
      items,
    };
    await this.cache.set(cacheKey, result, 30).catch(() => undefined);
    return result;
  }

  /**
   * Personalised "For You" feed — the Instagram-home-feed equivalent.
   * Rules-based taste ranking over a candidate pool built from charts,
   * the user's own recent searches and their top learned artists, plus the
   * shared discovery mix so favourites never crowd out fresh picks.
   * Anonymous callers get the same shape with a popular/trending ranking.
   */
  async getForYou(opts: { userId?: string; limit?: number; seed?: string }) {
    const limitRaw = Number(opts?.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(5, Math.min(30, Math.floor(limitRaw)))
      : 18;
    const seed = sanitizeSeed(opts?.seed);
    const userId = typeof opts?.userId === 'string' ? opts.userId : '';

    const cacheKey = `reels_foryou_${userId || 'anon'}_${seed}_${limit}`;
    const cached = await this.cache.get<{
      seed: string;
      generatedAt: string;
      personalized: boolean;
      count: number;
      items: ReelFeedItem[];
    }>(cacheKey).catch(() => null);
    if (cached) return cached;

    const pool = await this.getForYouCandidates(userId, limit);

    let prefs: ReelPrefs = {};
    let feedback: ReelFeedback = {};
    let taste = null;
    let searchTokens: string[] = [];
    let behavior: ReelBehavior | null = null;
    if (userId) {
      const signals = await this.loadUserSignals(userId).catch(() => null);
      if (signals) {
        prefs = signals.prefs;
        feedback = signals.feedback;
      }
      const [profile, queries, recentEvents] = await Promise.all([
        this.taste.getProfileForUser(userId).catch(() => null),
        this.taste.getRecentSearchTokens(userId, 10).catch(() => []),
        this.prisma.listeningEvent
          .findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 60,
            select: { trackId: true, title: true, artist: true, eventType: true },
          })
          .catch(() => [] as any[]),
      ]);
      if (isUsableTaste(profile)) taste = profile;
      searchTokens = queries;
      behavior = this.buildBehavior(recentEvents as any[]);
    }

    const sess = userId ? this.session.context(userId) : null;

    const items = scoreCandidates(pool, {
      seed,
      mood: null,
      prefs,
      taste,
      feedback,
      searchTokens,
      behavior,
      session: sess?.session ?? null,
      appetite: sess?.appetite,
      discovery: true,
      limit,
    }).slice(0, limit);

    const personalized =
      !!userId &&
      (isUsableTaste(taste) ||
        (prefs.artists || []).length > 0 ||
        (prefs.moods || []).length > 0 ||
        (feedback.likedIds || []).length > 0);

    this.logger.log(
      `For You seed=${seed} pool=${pool.length} -> ${items.length} items (personalized=${personalized})`,
    );

    const result = {
      seed,
      generatedAt: new Date().toISOString(),
      personalized,
      count: items.length,
      items,
    };
    await this.cache.set(cacheKey, result, 30).catch(() => undefined);
    return result;
  }

  /**
   * For You candidates: shared chart/catalog base (cacheable) plus up to
   * four intent queries — the user's recent searches first, then their top
   * learned artists. Query provenance carries language for taste matching.
   */
  private async getForYouCandidates(userId: string, limit: number): Promise<ReelCandidate[]> {
    const baseKey = `foryou:pool:${limit}`;
    let base = await this.cache.get<ReelCandidate[]>(baseKey).catch(() => null);
    if (!base || !Array.isArray(base) || base.length === 0) {
      // Exploration slice: one trending pull from a language the base chart
      // doesn't use (hindi vs the tamil base), so users whose taste is the
      // base language can still be offered true "unexpected gem" picks —
      // classification decides per user which side is adjacent vs fresh.
      const probeLang = KNOWN_LANGS.find((l) => l !== 'tamil') || 'hindi';
      const [trendRes, probeRes, catRes] = await Promise.allSettled([
        this.jioSaavn.getTrendingSongs(limit * 2, { stable: true, lang: 'tamil' }),
        this.jioSaavn.getTrendingSongs(limit, { stable: true, lang: probeLang }),
        this.loadCatalogPool('chill', limit),
      ]);
      const trend =
        trendRes.status === 'fulfilled'
          ? this.mapExternal(trendRes.value, 'saavn', { language: 'tamil' })
          : [];
      const probe =
        probeRes.status === 'fulfilled'
          ? this.mapExternal(probeRes.value, 'saavn', { language: probeLang })
          : [];
      const cat = catRes.status === 'fulfilled' ? catRes.value : [];
      if (trendRes.status === 'rejected') this.logger.warn(`For You trending failed: ${String(trendRes.reason)}`);
      if (probeRes.status === 'rejected') this.logger.warn(`For You probe failed: ${String(probeRes.reason)}`);
      base = [...trend, ...probe, ...cat];
      if (base.length > 0) {
        await this.cache.set(baseKey, base, 300).catch(() => undefined);
      }
    }

    if (!userId) return base;

    // Intent queries: own recent searches + top learned artists.
    const queries: string[] = [];
    try {
      const [recent, profile] = await Promise.all([
        this.taste.getRecentSearchTokens(userId, 10),
        this.taste.getProfileForUser(userId),
      ]);
      for (const q of recent.slice(0, 2)) queries.push(q);
      const lang = profile.languages[0]?.name || 'tamil';
      // Fill remaining intent slots with learned artists — more taste history
      // → more artist queries → more familiar stock for the 60% bucket.
      const artistSlots = Math.max(2, 4 - queries.length);
      for (const s of profile.singers.slice(0, artistSlots)) queries.push(`${s.name} ${lang} songs`);
    } catch {
      // Signals unavailable → charts alone still form a sane feed.
    }

    const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
    if (unique.length === 0) return base;

    const results = await Promise.allSettled(unique.map((q) => this.youtube.searchTracks(q)));
    const fromQueries: ReelCandidate[] = [];
    results.forEach((res, i) => {
      if (res.status !== 'fulfilled') {
        this.logger.warn(`For You query failed (${unique[i]}): ${String(res.reason)}`);
        return;
      }
      fromQueries.push(
        ...this.mapExternal(res.value, 'youtube', { language: inferLanguage(unique[i]) }),
      );
    });

    return [...fromQueries, ...base];
  }

  /** Candidate pool: mood search first, Saavn charts, then local catalog. */
  private async getCandidates(mood: string, lang: string, limit: number): Promise<ReelCandidate[]> {
    const cacheKey = `reels:pool:${mood || 'all'}:${lang}:${limit}`;
    const cached = await this.cache.get<ReelCandidate[]>(cacheKey).catch(() => null);
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;

    // Cross-language exploration slice — gems the mood/chart side can't
    // source on its own (same shared-pool trick as For You).
    const probeLang = KNOWN_LANGS.find((l) => l !== lang) || 'hindi';
    const [moodRes, trendRes, probeRes, catRes] = await Promise.allSettled([
      mood
        ? this.youtube.searchTracks(`${lang} ${MOOD_QUERIES[mood] || `${mood} songs`}`)
        : Promise.resolve([]),
      this.jioSaavn.getTrendingSongs(limit * 2, { stable: true, lang }),
      this.jioSaavn.getTrendingSongs(limit, { stable: true, lang: probeLang }),
      this.loadCatalogPool(mood, limit),
    ]);

    // Mood-search results are tagged with the mood that retrieved them so
    // the scorer's mood bonus applies (they were fetched *for* this mood).
    // Charts are language-scoped, so their rows carry that language for
    // taste matching — provenance, not a metadata guess.
    const moodCandidates: ReelCandidate[] =
      moodRes.status === 'fulfilled'
        ? this.mapExternal(moodRes.value, 'youtube', {
            language: inferLanguage(`${lang} ${MOOD_QUERIES[mood] || ''}`),
          }).map((c) => ({ ...c, moodTags: mood ? [mood] : [] }))
        : [];
    const trendCandidates: ReelCandidate[] =
      trendRes.status === 'fulfilled'
        ? this.mapExternal(trendRes.value, 'saavn', { language: inferLanguage(lang) })
        : [];
    const probeCandidates: ReelCandidate[] =
      probeRes.status === 'fulfilled'
        ? this.mapExternal(probeRes.value, 'saavn', { language: probeLang })
        : [];
    const catalogCandidates: ReelCandidate[] =
      catRes.status === 'fulfilled' ? catRes.value : [];

    if (moodRes.status === 'rejected') {
      this.logger.warn(`Mood search failed (${mood}): ${String(moodRes.reason)}`);
    }
    if (trendRes.status === 'rejected') {
      this.logger.warn(`Trending failed: ${String(trendRes.reason)}`);
    }
    if (probeRes.status === 'rejected') {
      this.logger.warn(`Probe trending failed (${probeLang}): ${String(probeRes.reason)}`);
    }

    const pool = [...moodCandidates, ...trendCandidates, ...probeCandidates, ...catalogCandidates];
    if (pool.length > 0) {
      await this.cache.set(cacheKey, pool, 300).catch(() => undefined);
    }
    return pool;
  }

  /**
   * Familiar stock from the user's top learned artists (per-user, uncached).
   * Classification is at scoring time: results whose artists appear in the
   * taste profile land in the familiar bucket regardless of their language
   * tag, so a chart-only pool no longer starves the 60% share.
   */
  private async getTasteArtistCandidates(taste: any, lang: string): Promise<ReelCandidate[]> {
    if (!taste || !Array.isArray(taste.singers)) return [];
    const names: string[] = taste.singers
      .filter((s: any) => s && s.affinity > 0 && typeof s.name === 'string' && s.name)
      .slice(0, 2)
      .map((s: any) => String(s.name));
    if (names.length === 0) return [];
    const results = await Promise.allSettled(
      names.map((n) => this.youtube.searchTracks(`${n} ${lang} songs`)),
    );
    const out: ReelCandidate[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        out.push(...this.mapExternal(res.value, 'youtube', { language: lang }));
      } else {
        this.logger.warn(`Taste artist query failed (${names[i]}): ${String(res.reason)}`);
      }
    });
    return out;
  }

  private mapExternal(
    rows: any[],
    provider: 'youtube' | 'saavn',
    opts: { language?: string | null } = {},
  ): ReelCandidate[] {
    if (!Array.isArray(rows)) return [];
    const out: ReelCandidate[] = [];
    rows.forEach((r, idx) => {
      if (!r || typeof r.id !== 'string' || !r.id) return;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      if (!title) return;
      const artistRaw = typeof r.artists === 'string' ? r.artists : 'Unknown Artist';
      const artists = artistRaw
        .split(',')
        .map((a: string) => a.trim())
        .filter(Boolean);
      out.push({
        id: r.id,
        title,
        artist: artistRaw.trim() || 'Unknown Artist',
        artists,
        albumArt: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
        duration: typeof r.duration === 'number' ? r.duration : undefined,
        source: typeof r.source === 'string' ? r.source : undefined,
        provider,
        rank: idx,
        language: opts.language ?? (typeof r.language === 'string' && r.language ? r.language : null),
        era: eraFromYear(r.year),
      });
    });
    return out;
  }

  private async loadCatalogPool(mood: string, limit: number): Promise<ReelCandidate[]> {
    try {
      const params = this.moodEngine.getParamsForMood(mood || 'chill');
      const rows = await this.prisma.track.findMany({
        where: {
          energy: { gte: params.energy.min, lte: params.energy.max },
          tempo: { gte: params.tempo.min, lte: params.tempo.max },
        },
        include: { artists: { include: { artist: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit * 2,
      });
      return (rows || []).map((t: any) => {
        const artists: string[] = (t.artists || [])
          .map((a: any) => a?.artist?.name)
          .filter((n: any): n is string => typeof n === 'string' && !!n);
        let moodTags: string[] = [];
        try {
          const parsed = typeof t.mood === 'string' ? JSON.parse(t.mood) : t.mood;
          if (Array.isArray(parsed)) moodTags = parsed.filter((m: any) => typeof m === 'string');
        } catch {
          // Plain-word mood column — use it directly.
          if (typeof t.mood === 'string' && t.mood) moodTags = [t.mood];
        }
        const streamableId =
          typeof t.playbackSourceId === 'string' && t.playbackSourceId
            ? t.playbackSourceId
            : t.id;
        return {
          id: streamableId,
          title: t.title,
          artist: artists.join(', ') || 'Unknown Artist',
          artists,
          albumArt: t.artworkUrl || undefined,
          duration: typeof t.duration === 'number' ? t.duration : undefined,
          source: 'Yazh Catalog',
          provider: 'catalog' as const,
          moodTags,
          genre: t.genre || null,
          language: t.language || null,
          era: t.era || null,
          energy: typeof t.energy === 'number' ? t.energy : null,
        };
      });
    } catch (err) {
      this.logger.warn(`Catalog pool failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Aggregate recent listening events into the scorer's behaviour component
   * (title/artist completions·replays·skips + newest-first recents for the
   * repeat filter). Failures degrade to "no behaviour" — never block a feed.
   */
  private buildBehavior(
    events: Array<{ trackId: string; title: string; artist: string; eventType: string }>,
  ): ReelBehavior | null {
    if (!Array.isArray(events) || events.length === 0) return null;
    const titles: NonNullable<ReelBehavior['titles']> = {};
    const artists: NonNullable<ReelBehavior['artists']> = {};
    const recentPlays: string[] = [];
    const recentIds: string[] = [];
    const seenTitles = new Set<string>();
    const seenIds = new Set<string>();

    for (const e of events) {
      const nt = normalizeTitle(e.title);
      if (nt) {
        const slot = (titles[nt] ||= { completions: 0, skips: 0, replays: 0 });
        if (e.eventType === 'complete') slot.completions++;
        else if (e.eventType === 'replay') slot.replays++;
        else if (e.eventType === 'skip') slot.skips++;
        if (!seenTitles.has(nt)) {
          seenTitles.add(nt);
          if (recentPlays.length < 15) recentPlays.push(nt);
        }
      }
      const id = e.trackId || '';
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        if (recentIds.length < 15) recentIds.push(id);
      }
      for (const name of splitArtists(e.artist)) {
        const key = name.toLowerCase();
        const slot = (artists[key] ||= { completions: 0, skips: 0 });
        if (e.eventType === 'complete') slot.completions++;
        else if (e.eventType === 'replay') slot.completions++;
        else if (e.eventType === 'skip') slot.skips++;
      }
    }
    return { titles, artists, recentPlays, recentIds };
  }

  private async loadUserSignals(
    userId: string,
  ): Promise<{ prefs: ReelPrefs; feedback: ReelFeedback }> {
    const [user, profile, events] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { preferences: true },
      }),
      this.prisma.profile.findUnique({ where: { userId }, select: { library: true } }),
      this.prisma.reelEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { trackId: true, eventType: true },
      }),
    ]);

    const p = user?.preferences;
    const prefs: ReelPrefs = {
      moods: safeJsonArray(p?.preferredMoods),
      genres: safeJsonArray(p?.preferredGenres),
      artists: safeJsonArray(p?.preferredArtists),
      languages: safeJsonArray(p?.preferredLanguages),
      energy: typeof p?.preferredEnergy === 'number' ? p.preferredEnergy : null,
    };

    const likedIds: string[] = [];
    const likedTitles: string[] = [];
    const skippedIds: string[] = [];
    const hiddenIds: string[] = [];

    // Library snapshot likes (title/artist based, any source id).
    try {
      const lib = JSON.parse(profile?.library || 'null');
      const liked: any[] = Array.isArray(lib?.liked) ? lib.liked : [];
      for (const s of liked.slice(0, 100)) {
        if (s && typeof s.id === 'string') likedIds.push(s.id);
        if (s && typeof s.title === 'string') likedTitles.push(s.title);
      }
    } catch {
      // Corrupt library snapshot — skip likes, feed still works.
    }

    for (const e of events || []) {
      const id = typeof e.trackId === 'string' ? e.trackId : '';
      if (!id) continue;
      if (e.eventType === 'like') {
        if (!likedIds.includes(id)) likedIds.push(id);
      } else if (e.eventType === 'not_interested') {
        if (!hiddenIds.includes(id)) hiddenIds.push(id);
      } else if (e.eventType === 'skip') {
        if (!skippedIds.includes(id)) skippedIds.push(id);
      } else if (e.eventType === 'undo_not_interested') {
        const at = hiddenIds.indexOf(id);
        if (at >= 0) hiddenIds.splice(at, 1);
      } else if (e.eventType === 'unlike') {
        const at = likedIds.indexOf(id);
        if (at >= 0) likedIds.splice(at, 1);
      }
    }

    return {
      prefs,
      feedback: { likedIds, likedTitles, skippedIds, hiddenIds, hiddenTitles: [] },
    };
  }

  /**
   * Recommendation reset — clears the signals that shape the feed for this
   * user (reel feedback, search intent, live session) so the next request
   * starts fresh. Explicit library likes / catalog favorites are the user's
   * own collection, not recommendation state, and are intentionally kept.
   */
  async resetRecommendations(
    userId: string,
  ): Promise<{ clearedReelEvents: number; clearedSearchIntents: number }> {
    if (!userId) throw new BadRequestException('userId required');
    const [reels, intents] = await Promise.all([
      this.prisma.reelEvent.deleteMany({ where: { userId } }),
      this.prisma.searchIntent.deleteMany({ where: { userId } }).catch(() => ({ count: 0 })),
    ]);
    this.session.clear(userId);
    // Feed caches are keyed per (user, mood, lang, seed, page) with a 30s
    // TTL — the pre-reset order self-expires within one cache window.
    this.logger.log(`Recommendations reset for user (reels=${reels.count}, intents=${intents.count})`);
    return { clearedReelEvents: reels.count, clearedSearchIntents: intents.count };
  }

  /**
   * Outcome metrics for this user's feed session behaviour — the
   * observability surface: meaningful listening, completion, skips,
   * likes, repetition, artist diversity, discovery uptake.
   */
  async getMetrics(userId: string, windowDays = 30): Promise<ReelMetrics & { windowDays: number }> {
    if (!userId) throw new BadRequestException('userId required');
    // Note: `Number(x) || 30` would treat an explicit 0 as "default" — a
    // caller passing 0 (or a negative) wants the minimum window, not 30.
    const parsedDays = Number(windowDays);
    const days = Number.isFinite(parsedDays)
      ? Math.max(1, Math.min(365, Math.floor(parsedDays)))
      : 30;
    const since = new Date(Date.now() - days * 86400000);
    const [reelEvents, historyEvents] = await Promise.all([
      this.prisma.reelEvent.findMany({
        where: { userId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: { eventType: true, dwellMs: true, artist: true, trackId: true, discovery: true },
      }),
      this.prisma.listeningEvent.findMany({
        where: { userId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { eventType: true, position: true, duration: true, artist: true },
      }),
    ]);
    const metrics = computeReelMetrics(reelEvents as any[], historyEvents as any[]);
    return { ...metrics, windowDays: days };
  }

  async recordEvents(userId: string, body: any): Promise<{ recorded: number; rejected: number }> {
    const raw: any[] = Array.isArray(body?.events)
      ? body.events
      : Array.isArray(body)
        ? body
        : [];
    if (raw.length === 0) throw new BadRequestException('events must be a non-empty array');

    const rows: any[] = [];
    let rejected = 0;
    if (raw.length > MAX_EVENTS_PER_CALL) rejected += raw.length - MAX_EVENTS_PER_CALL;

    for (const e of raw.slice(0, MAX_EVENTS_PER_CALL)) {
      const trackId = typeof e?.trackId === 'string' ? e.trackId.trim().slice(0, 128) : '';
      const eventType = typeof e?.eventType === 'string' ? e.eventType.trim() : '';
      if (!trackId || !eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
        rejected++;
        continue;
      }
      const dwell = Number(e?.dwellMs);
      // Snapshots: external ids never resolve against the catalog, so the
      // title/artist ride along with the event for taste matching.
      const title = typeof e?.title === 'string' ? e.title.trim().slice(0, 200) : '';
      const artist = typeof e?.artist === 'string' ? e.artist.trim().slice(0, 200) : '';
      rows.push({
        userId,
        trackId,
        eventType,
        feedId: typeof e?.feedId === 'string' && e.feedId ? e.feedId.slice(0, 64) : null,
        mood: typeof e?.mood === 'string' && e.mood ? sanitizeToken(e.mood, 32) || null : null,
        dwellMs: Number.isFinite(dwell) ? Math.max(0, Math.min(600000, Math.round(dwell))) : 0,
        title: title || null,
        artist: artist || null,
        discovery: e?.discovery === true,
      });
      // Session layer: appetite + repeat/singer/mood context for the next request.
      this.session.record(userId, {
        eventType,
        artist,
        title,
        mood: typeof e?.mood === 'string' ? e.mood : null,
        discovery: e?.discovery === true,
        dwellMs: Number.isFinite(dwell) ? dwell : 0,
      });
    }

    if (rows.length > 0) {
      await this.prisma.reelEvent.createMany({ data: rows });
      // Keep event history bounded without an unbounded table scan.
      const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
      await this.prisma.reelEvent
        .deleteMany({ where: { userId, createdAt: { lt: new Date(cutoff) } } })
        .catch(() => undefined);
    }

    return { recorded: rows.length, rejected };
  }

  async getPreferences(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { preferences: true },
    });
    const p = user?.preferences;
    return {
      moods: safeJsonArray(p?.preferredMoods),
      genres: safeJsonArray(p?.preferredGenres),
      artists: safeJsonArray(p?.preferredArtists),
      languages: safeJsonArray(p?.preferredLanguages),
      energy: typeof p?.preferredEnergy === 'number' ? p.preferredEnergy : null,
    };
  }

  async updatePreferences(userId: string, dto: any) {
    const provided = (k: string) => dto && Object.prototype.hasOwnProperty.call(dto, k);

    const knownMoods = new Set(this.moodEngine.getAllMoods().map((m) => m.id));
    const moods = provided('moods')
      ? sanitizeList(dto.moods, 10).map((m) => m.toLowerCase()).filter((m) => knownMoods.has(m))
      : undefined;
    const genres = provided('genres') ? sanitizeList(dto.genres, 20) : undefined;
    const artists = provided('artists') ? sanitizeList(dto.artists, 20) : undefined;
    const languages = provided('languages') ? sanitizeList(dto.languages, 10) : undefined;
    let energy: number | null | undefined;
    if (provided('energy')) {
      const e = dto.energy;
      energy = e === null ? null : typeof e === 'number' && e >= 0 && e <= 1 ? e : undefined;
      if (energy === undefined) throw new BadRequestException('energy must be 0..1 or null');
    }

    const existing = await this.prisma.userPreferences.findUnique({ where: { userId } });

    const next = {
      preferredGenres:
        genres !== undefined ? JSON.stringify(genres) : existing?.preferredGenres ?? '[]',
      preferredArtists:
        artists !== undefined ? JSON.stringify(artists) : existing?.preferredArtists ?? '[]',
      preferredMoods:
        moods !== undefined ? JSON.stringify(moods) : existing?.preferredMoods ?? '[]',
      preferredLanguages:
        languages !== undefined ? JSON.stringify(languages) : existing?.preferredLanguages ?? '[]',
      preferredEnergy: energy !== undefined ? energy : existing?.preferredEnergy ?? null,
    };

    await this.prisma.userPreferences.upsert({
      where: { userId },
      update: next,
      create: { userId, ...next },
    });

    return {
      moods: safeJsonArray(next.preferredMoods),
      genres: safeJsonArray(next.preferredGenres),
      artists: safeJsonArray(next.preferredArtists),
      languages: safeJsonArray(next.preferredLanguages),
      energy: typeof next.preferredEnergy === 'number' ? next.preferredEnergy : null,
    };
  }
}
