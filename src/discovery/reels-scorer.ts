import { TasteProfile, scoreTrack, isUsableTaste } from './taste-profile.service';
import { getReelsConfig, DEFAULT_REELS_CONFIG, ReelsScoringConfig } from './reels-config';

/**
 * Deterministic Reels/For-You ranking — transparent rules, no ML.
 *
 * Every eligible candidate is scored from five weighted components
 * (starting hypothesis, tuned later from real behaviour):
 *
 *   personal taste match   30%   (learned profile + likes + saved prefs)
 *   listening behaviour    25%   (completes/replays up, skips down)
 *   selected mood/context  15%   (requested mood, energy, session mood)
 *   artist/genre/language  15%   (relevance, search intent, popularity)
 *   discovery & diversity  15%   (fresh artists the user hasn't heard)
 *
 * …plus explicit penalties for recent repeats, then the sequence is
 * composed by buckets — ~60% familiar favourites, ~25% similar discoveries,
 * ~15% unexpected gems (adaptive via `appetite`) — with familiar picks
 * front-loaded and exploration ramping later in the feed. Same inputs +
 * seed always produce the same order: a refresh never reshuffles the feed
 * under the user's thumb.
 */

export type PlaybackAvailability = 'playable' | 'preview_only' | 'external_only' | 'unavailable';

export type ReelProvider = 'saavn' | 'youtube' | 'catalog';

/** Feed slot family — drives the familiar/similar/discovery composition. */
export type ReelBucket = 'familiar' | 'similar' | 'discovery';

export interface ReelCandidate {
  /** The id the client will play (YouTube11-char / saavn-… / raw catalog id). */
  id: string;
  title: string;
  artist: string;
  artists?: string[];
  albumArt?: string;
  duration?: number;
  source?: string;
  provider: ReelProvider;
  /** 0-based popularity rank inside its source list (0 = top of chart). */
  rank?: number;
  /** Mood tags this candidate satisfies (catalog mood / matched query). */
  moodTags?: string[];
  genre?: string | null;
  language?: string | null;
  era?: string | null;
  energy?: number | null;
  /** Only a30s preview is streamable. */
  preview?: boolean;
  /** No in-app stream; open externally instead. */
  externalUrl?: string | null;
}

export interface ReelFeedback {
  likedIds?: string[];
  /** Normalized-or-raw titles (library likes are title/artist based). */
  likedTitles?: string[];
  skippedIds?: string[];
  /** not_interested — hard-excluded. */
  hiddenIds?: string[];
  hiddenTitles?: string[];
}

export interface ReelPrefs {
  moods?: string[];
  genres?: string[];
  artists?: string[];
  languages?: string[];
  energy?: number | null;
}

/** Recent listening behaviour (any source) — the25% behaviour component. */
export interface ReelBehavior {
  /** normalizedTitle → counts. */
  titles?: Record<string, { completions: number; skips: number; replays: number }>;
  /** lowercase artist name → counts. */
  artists?: Record<string, { completions: number; skips: number }>;
  /** Newest-first normalized titles — recent-repeat filter. */
  recentPlays?: string[];
  /** Newest-first track ids — recent-repeat filter. */
  recentIds?: string[];
}

/** This listening session — smooth adaptation, never a hard block. */
export interface ReelSessionContext {
  /** Normalized titles played/started in the session (newest first). */
  playedTitles?: string[];
  /** Artist → completions this session (lifts taste for the session). */
  singerCompletions?: Record<string, number>;
  /** Artist → skips this session (soft sink, capped — one skip ≠ block). */
  singerSkips?: Record<string, number>;
  /** Mood → completions this session (mood continuity on switches). */
  moodCompletions?: Record<string, number>;
}

export interface ReelScoringContext {
  seed: string;
  mood?: string | null;
  /** Requested feed language — matched candidates get an "In {lang}" reason
   *  even for cold accounts with no saved preferences yet. */
  lang?: string | null;
  /** Tags that satisfy the requested mood (from MoodEngineService). */
  moodTags?: string[];
  prefs?: ReelPrefs;
  taste?: TasteProfile | null;
  feedback?: ReelFeedback;
  /** Recent search queries — token overlap lifts matching candidates. */
  searchTokens?: string[];
  /** false → plain score order (no bucket composition). Default: on. */
  discovery?: boolean;
  behavior?: ReelBehavior | null;
  session?: ReelSessionContext | null;
  /** Exploration appetite0.10..0.30 (default0.15 = the15% gems slot). */
  appetite?: number;
  /** Composition plan length — callers pass the feed limit. */
  limit?: number;
  /** Optional config override (tests / per-request tuning); defaults to env. */
  config?: ReelsScoringConfig;
}

export interface ReelFeedItem {
  feedId: string;
  id: string;
  title: string;
  artist: string;
  albumArt?: string;
  duration?: number;
  source?: string;
  provider: ReelProvider;
  availability: PlaybackAvailability;
  score: number;
  reasons: string[];
  rank?: number;
  /** Carried for history snapshots / client display when the source has it. */
  language?: string | null;
  era?: string | null;
  /** Which feed family this slot came from. */
  bucket: ReelBucket;
  /** True for unexpected gems (bucket === 'discovery'). */
  discovery: boolean;
}

/** Lowercase + strip punctuation so "Vaathi (Combo)" matches "vaathi combo". */
export function normalizeTitle(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0B80-\u0BFF ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FNV-1a32 — stable across runs/platforms (Math.random is not). */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Honest availability — never promise a stream we cannot deliver:
 * - playable:        id resolves through /tracks/stream/:id (YouTube or Saavn)
 * - preview_only:    only a30s preview is streamable
 * - external_only:   no in-app stream; an external URL exists
 * - unavailable:     nothing we can play from this app right now
 */
export function resolveAvailability(c: Pick<ReelCandidate, 'id' | 'provider' | 'preview' | 'externalUrl'>): PlaybackAvailability {
  if (c.externalUrl) return 'external_only';
  if (c.preview) return 'preview_only';
  const id = c.id || '';
  if (!id) return 'unavailable';
  if (c.provider === 'saavn') return id.startsWith('saavn-') && id.length > 6 ? 'playable' : 'unavailable';
  if (c.provider === 'youtube') return VIDEO_ID_RE.test(id) ? 'playable' : 'unavailable';
  // catalog: only usable when it carries a streamable external id
  return VIDEO_ID_RE.test(id) || id.startsWith('saavn-') ? 'playable' : 'unavailable';
}

const displayCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Component weights — the30/25/15/15/15 split, scaled to points.
 *  Defaults; live values come from getReelsConfig() (env-overridable). */
export const SCORE_WEIGHTS = DEFAULT_REELS_CONFIG.weights;

/** Base bucket mix:60% familiar,25% similar,15% exploration. */
export const BASE_BUCKETS = DEFAULT_REELS_CONFIG.buckets;
export const APPETITE_DEFAULT = DEFAULT_REELS_CONFIG.appetite.default;
export const APPETITE_MIN = DEFAULT_REELS_CONFIG.appetite.min;
export const APPETITE_MAX = DEFAULT_REELS_CONFIG.appetite.max;

interface Weighted {
  text: string;
  w: number;
}

interface Scored {
  candidate: ReelCandidate;
  nTitle: string;
  score: number;
  reasons: Weighted[];
  bucket: ReelBucket;
  // bucket-classification snapshots
  cDiscovery: number;
  familiarHit: boolean;
  sawTasteContext: boolean;
}

function primaryArtist(c: ReelCandidate): string {
  return ((c.artists && c.artists[0]) || c.artist || 'unknown artist').toLowerCase();
}

function artistTokens(c: ReelCandidate): string[] {
  const list = (c.artists && c.artists.length > 0 ? c.artists : [c.artist])
    .map((a) => (a || '').trim().toLowerCase())
    .filter(Boolean);
  return list;
}

/** Merge duplicate reason texts (taste + prefs can phrase the same hit). */
function dedupeReasons(reasons: Weighted[]): Weighted[] {
  const best = new Map<string, Weighted>();
  for (const r of reasons) {
    const prev = best.get(r.text);
    if (!prev || r.w > prev.w) best.set(r.text, r);
  }
  return [...best.values()].sort((a, b) => b.w - a.w);
}

function scoreOne(candidate: ReelCandidate, ctx: ReelScoringContext, sets: {
  likedIds: Set<string>;
  likedTitles: Set<string>;
  skippedIds: Set<string>;
}): Scored | null {
  const nTitle = normalizeTitle(candidate.title);
  const reasons: Weighted[] = [];
  const cfg = ctx.config ?? getReelsConfig();
  const W = cfg.weights;

  // ---- Component: personal taste match (30%) --------------------------
  let cTaste = 0;
  const liked = sets.likedIds.has(candidate.id) || sets.likedTitles.has(nTitle);
  if (liked) {
    cTaste += 0.9;
    reasons.push({ text: 'You liked this', w: W.taste * 0.9 });
  }

  const tokens = artistTokens(candidate);
  const taste = isUsableTaste(ctx.taste) ? ctx.taste : null;
  // Any positive singer match = an artist the user KNOWS (bucket: familiar).
  let tasteSingerAny = false;
  let tasteMatched = false; // taste score > 0 from any dimension (adjacency)
  if (taste) {
    const { score: tRaw, reasons: tReasons } = scoreTrack(taste, {
      genre: candidate.genre,
      language: candidate.language,
      singers: tokens,
      composer: undefined,
      mood: (candidate.moodTags || [])[0],
      era: candidate.era,
      energy: candidate.provider === 'catalog' ? candidate.energy : null,
    });
    const tNorm = clamp(tRaw / 4, -1, 1);
    cTaste += tNorm;
    for (const text of tReasons) reasons.push({ text, w: W.taste * tNorm });
    tasteSingerAny = taste.singers.some((s) => s.affinity > 0 && tokens.includes(s.name));
    tasteMatched = tNorm > 0;
  }

  const prefs = ctx.prefs || {};
  let prefArtistHit = false;
  let prefLangHit = false;
  let prefGenreHit = false;
  let prefMoodHit = false;
  if (prefs.artists && prefs.artists.length > 0) {
    const prefArtists = new Set(prefs.artists.map((a) => a.trim().toLowerCase()));
    const hit = tokens.find((a) => prefArtists.has(a));
    if (hit) {
      prefArtistHit = true;
      cTaste += 0.4;
      reasons.push({ text: `More from ${displayCase(hit)}`, w: W.taste * 0.4 });
    }
  }
  if (candidate.genre && prefs.genres && prefs.genres.length > 0) {
    const g = candidate.genre.trim().toLowerCase();
    if (prefs.genres.some((x) => x.trim().toLowerCase() === g)) {
      prefGenreHit = true;
      cTaste += 0.2;
      reasons.push({ text: `${displayCase(g)} vibes`, w: W.taste * 0.2 });
    }
  }
  if (candidate.language && prefs.languages && prefs.languages.length > 0) {
    const l = candidate.language.trim().toLowerCase();
    if (prefs.languages.some((x) => x.trim().toLowerCase() === l)) {
      prefLangHit = true;
      cTaste += 0.15;
      reasons.push({ text: `In ${displayCase(l)}`, w: W.taste * 0.15 });
    }
  }

  // Session learning: artists the user is finishing right now lift up —
  // smoothly, alongside (never instead of) the long-term profile.
  const session = ctx.session || null;
  let sessionArtistHit = false;
  if (session?.singerCompletions) {
    let best = 0;
    for (const t of tokens) best = Math.max(best, session.singerCompletions[t] || 0);
    if (best > 0) {
      sessionArtistHit = true;
      // Strong enough to keep a session favourite above a full stranger
      // (0.6 × 3 = 1.8 pts vs discovery's max 1.5), capped so a handful of
      // listens can never outweigh an explicit like.
      cTaste += Math.min(0.6, 0.2 * best);
    }
  }
  cTaste = clamp(cTaste, -1, 1);

  // ---- Component: listening behaviour (25%) ---------------------------
  let cBehavior = 0;
  const tb = ctx.behavior?.titles?.[nTitle];
  let behaviorTitleHit = false;
  if (tb) {
    // Replays outweigh completes (0.7 vs 0.3 each) and both saturate at 1,
    // so a loved track keeps beating a merely-finished one while in range.
    const pos = Math.min(1, tb.completions * 0.3 + tb.replays * 0.7);
    const neg = Math.min(1, tb.skips * 0.5);
    if (tb.completions + tb.replays > 0) {
      behaviorTitleHit = true;
      reasons.push({ text: 'You listened to this before', w: W.behavior * 0.25 });
    }
    cBehavior += pos - neg;
  }
  let artistCompletions = 0;
  if (ctx.behavior?.artists) {
    for (const t of tokens) {
      const ab = ctx.behavior.artists[t];
      if (!ab) continue;
      artistCompletions += ab.completions;
      cBehavior += 0.35 * (Math.min(1, ab.completions * 0.4) - Math.min(1, ab.skips * 0.5));
    }
  }
  if (sets.skippedIds.has(candidate.id)) cBehavior -= 0.4;
  if (session?.singerSkips) {
    // Repeated skips of an artist sink it — capped so one bad moment can
    // never block a whole style (spec: don't hard-block on a single skip).
    let sink = 0;
    for (const t of tokens) sink += Math.min(0.5, 0.25 * (session.singerSkips[t] || 0));
    cBehavior -= sink;
  }
  cBehavior = clamp(cBehavior, -1, 1);

  // ---- Component: selected mood / context (15%) -----------------------
  let cContext = 0;
  const moodId = (ctx.mood || '').toLowerCase();
  if (moodId) {
    const tags = (candidate.moodTags || []).map((t) => t.toLowerCase());
    const allowed = new Set((ctx.moodTags || []).map((t) => t.toLowerCase()));
    if (tags.includes(moodId) || tags.some((t) => allowed.has(t))) {
      cContext = 0.9;
      reasons.push({ text: `${displayCase(moodId)} mood`, w: W.context * 0.9 });
    }
  }
  if (moodId && (session?.moodCompletions?.[moodId] || 0) >= 2) {
    // The session is landing on this mood — keep leaning into it.
    cContext = Math.min(1, cContext + 0.2);
  }
  if (prefs.moods && prefs.moods.length > 0 && candidate.moodTags) {
    const prefMoods = new Set(prefs.moods.map((m) => m.trim().toLowerCase()));
    const hit = candidate.moodTags.find((m) => prefMoods.has(m.trim().toLowerCase()));
    if (hit) {
      prefMoodHit = true;
      if (cContext < 0.5) {
        cContext = 0.5;
        reasons.push({ text: `Your ${displayCase(hit)} picks`, w: W.context * 0.5 });
      }
    }
  }
  if (
    typeof prefs.energy === 'number' &&
    Number.isFinite(prefs.energy) &&
    typeof candidate.energy === 'number' &&
    Number.isFinite(candidate.energy)
  ) {
    const closeness = Math.max(0, 1 - Math.abs(candidate.energy - prefs.energy));
    if (closeness > 0.6 && closeness > cContext) {
      cContext = closeness;
      reasons.push({ text: 'Matches your energy', w: W.context * closeness });
    }
  }
  cContext = clamp(cContext, 0, 1);

  // ---- Component: relevance (15%) -------------------------------------
  let cRelevance = 0;
  let searchHit = false;
  if (typeof candidate.rank === 'number' && Number.isFinite(candidate.rank)) {
    const popNorm = Math.max(0, 1 - Math.max(0, candidate.rank) / 50);
    cRelevance += popNorm * 0.45;
    if (popNorm >= 0.6) reasons.push({ text: 'Trending now', w: W.relevance * popNorm * 0.45 });
  }
  if (
    candidate.language &&
    ctx.lang &&
    candidate.language.trim().toLowerCase() === ctx.lang.trim().toLowerCase()
  ) {
    // Feed-language match — honest context chip for cold accounts too
    // (prefs.languages is empty until the user saves settings server-side).
    cRelevance += 0.15;
    reasons.push({ text: `In ${displayCase(candidate.language)}`, w: W.relevance * 0.15 });
  }
  if (candidate.language && prefs.languages && prefs.languages.length > 0) {
    const l = candidate.language.trim().toLowerCase();
    if (prefs.languages.some((x) => x.trim().toLowerCase() === l)) cRelevance += 0.25;
  }
  if (candidate.genre && prefs.genres && prefs.genres.length > 0) {
    const g = candidate.genre.trim().toLowerCase();
    if (prefs.genres.some((x) => x.trim().toLowerCase() === g)) cRelevance += 0.2;
  }
  if (ctx.searchTokens && ctx.searchTokens.length > 0) {
    const queryTokens = new Set<string>();
    for (const q of ctx.searchTokens) {
      for (const w of q.toLowerCase().split(/[^a-z0-9\u0B80-\u0BFF]+/)) {
        if (w.length >= 3) queryTokens.add(w);
      }
    }
    if (queryTokens.size > 0) {
      const hay = `${candidate.title} ${candidate.artist}`.toLowerCase();
      let hits = 0;
      for (const tok of queryTokens) if (hay.includes(tok)) hits++;
      if (hits > 0) {
        const bonus = Math.min(0.6, hits * 0.3);
        searchHit = true;
        cRelevance += bonus;
        reasons.push({ text: 'Matches your recent search', w: W.relevance * bonus });
      }
    }
  }
  cRelevance = clamp(cRelevance, 0, 1);

  // ---- Component: discovery & diversity (15%) -------------------------
  // Fully unfamiliar artist → full novelty credit; known artist without
  // recent listens → half; recently heard → none.
  const artistKnown = liked || prefArtistHit || tasteSingerAny || sessionArtistHit;
  const artistHeard = tokens.some((t) => !!ctx.behavior?.artists?.[t]);
  let cDiscovery = artistKnown ? 0 : artistHeard ? 0.5 : 1;

  // ---- Recent-repeat penalty (constraint, not a block) ----------------
  let repeat = 0;
  const sessionPlayed = session?.playedTitles?.some((t) => t === nTitle) ?? false;
  const recentIdHit = ctx.behavior?.recentIds?.includes(candidate.id) ?? false;
  const recentIdx = ctx.behavior?.recentPlays?.findIndex((t) => t === nTitle) ?? -1;
  if (sessionPlayed || recentIdHit) repeat = cfg.repeatPenalties.session;
  else if (recentIdx >= 0) repeat = recentIdx < 8 ? cfg.repeatPenalties.recent : cfg.repeatPenalties.older;
  if (repeat < 0) {
    // Just heard ≠ fresh gem: cap novelty when the repeat penalty fires.
    cDiscovery = Math.min(cDiscovery, 0.5);
  }

  // ---- Bucket classification -------------------------------------------
  // familiar = artists/titles the user KNOWS (loved, saved, followed/learned,
  // completed, session-loved, pref-saved) — never a mere language overlap.
  // similar  = unknown artist but inside their taste space (language/genre/
  // mood/search adjacency, or an artist heard before without completions).
  // discovery = neither: a true unexpected gem.
  const familiarHit =
    liked ||
    prefArtistHit ||
    tasteSingerAny ||
    sessionArtistHit ||
    behaviorTitleHit ||
    artistCompletions > 0;
  const sawTasteContext =
    tasteMatched || prefLangHit || prefGenreHit || prefMoodHit || searchHit || artistHeard;

  const score =
    W.taste * cTaste +
    W.behavior * cBehavior +
    W.context * cContext +
    W.relevance * cRelevance +
    W.discovery * cDiscovery +
    repeat;

  const deduped = dedupeReasons(reasons);
  return {
    candidate,
    nTitle,
    score: round2(score),
    reasons: deduped,
    bucket: 'similar', // assigned below
    cDiscovery,
    familiarHit,
    sawTasteContext,
  };
}

/**
 * Slot family — the user-facing balance:
 * - familiar: likes, saved/learned artists, session loves, past listens
 * - similar:  unknown artists adjacent to the user's taste (or heard once)
 * - discovery: artist entirely unknown to taste/behaviour/prefs
 */
function classifyBucket(s: Scored): ReelBucket {
  if (s.familiarHit) return 'familiar';
  if (s.sawTasteContext) return 'similar';
  if (s.cDiscovery >= 1) return 'discovery';
  return 'similar';
}

/**
 * Bucket composition — smooth weighted-deficit scheduling so the mix hits
 * the target ratios without clumping, familiar picks lead the open (the
 * first two slots establish the vibe) and exploration ramps toward the
 * back of the feed (later songs introduce gems). Exact integer counts via
 * largest-remainder; a short bucket falls back to whichever has stock.
 */
function composeByBuckets(
  ranked: Scored[],
  seed: string,
  appetite: number,
  planLen: number,
  cfg: ReelsScoringConfig,
): Scored[] {
  if (ranked.length === 0) return [];
  const n = Math.max(1, Math.min(planLen, ranked.length));
  const raw = {
    familiar: cfg.buckets.familiar,
    similar: cfg.buckets.similar,
    discovery: clamp(appetite, cfg.appetite.min, cfg.appetite.max),
  };
  const rawSum = raw.familiar + raw.similar + raw.discovery;
  const target = {
    familiar: (raw.familiar / rawSum) * n,
    similar: (raw.similar / rawSum) * n,
    discovery: (raw.discovery / rawSum) * n,
  };
  const counts: Record<ReelBucket, number> = {
    familiar: Math.floor(target.familiar),
    similar: Math.floor(target.similar),
    discovery: Math.floor(target.discovery),
  };
  const order: ReelBucket[] = ['familiar', 'similar', 'discovery'];
  let leftover = n - (counts.familiar + counts.similar + counts.discovery);
  for (const b of [...order].sort((a, z) => target[z] - target[a])) {
    if (leftover <= 0) break;
    counts[b]++;
    leftover--;
  }

  const lists: Record<ReelBucket, Scored[]> = { familiar: [], similar: [], discovery: [] };
  for (const s of ranked) lists[s.bucket].push(s);

  const used: Record<ReelBucket, number> = { familiar: 0, similar: 0, discovery: 0 };
  const rem: Record<ReelBucket, number> = { ...counts };
  const out: Scored[] = [];

  const phaseOf = (i: number): number => (n <= 1 ? 0.5 : i / (n - 1));
  // Session progression: familiar leans early, discovery ramps late.
  const bias = (b: ReelBucket, ph: number): number => {
    if (b === 'familiar') return ph < 0.34 ? 1.3 : ph > 0.66 ? 0.75 : 1;
    if (b === 'discovery') return ph < 0.34 ? 0.55 : ph > 0.66 ? 1.45 : 1;
    return 1;
  };

  const pickFrom = (i: number): ReelBucket => {
    const ph = phaseOf(i);
    if (i < 2 && rem.familiar > 0 && lists.familiar.length > 0) return 'familiar';
    let best: ReelBucket | null = null;
    let bestScore = -Infinity;
    for (const b of order) {
      if (rem[b] <= 0 || lists[b].length === 0) continue;
      const ideal = (counts[b] / n) * (i + 1);
      const d = (ideal - used[b]) * bias(b, ph);
      if (d > bestScore) {
        bestScore = d;
        best = b;
      }
    }
    if (best) return best;
    // Scheduled buckets exhausted/empty — take any stock left, prefer the
    // bucket with the largest unmet target so the mix degrades gracefully.
    let fallback: ReelBucket | null = null;
    let fbScore = -Infinity;
    for (const b of order) {
      if (lists[b].length === 0) continue;
      const d = counts[b] - used[b];
      if (d > fbScore) {
        fbScore = d;
        fallback = b;
      }
    }
    return fallback ?? 'similar';
  };

  for (let i = 0; i < n; i++) {
    const b = pickFrom(i);
    const item = lists[b].shift();
    if (!item) break;
    rem[b]--;
    used[b]++;
    out.push(item);
  }
  void seed; // reserved: seed-scrambled placement stays deterministic without it
  return out;
}

/**
 * Rank → diversify → classify → compose → package. Deterministic given
 * (candidates, ctx): ties are broken by a hash of `seed + id`, never by
 * array order alone. Diversity: at most DIVERSITY_CAP items per primary
 * artist, overflow preserved so a small pool still fills a feed.
 */
export function scoreCandidates(candidates: ReelCandidate[], ctx: ReelScoringContext): ReelFeedItem[] {
  const cfg = ctx.config ?? getReelsConfig();
  const fb = ctx.feedback || {};
  const hiddenIds = new Set(fb.hiddenIds || []);
  const hiddenTitles = new Set((fb.hiddenTitles || []).map(normalizeTitle));
  const sets = {
    likedIds: new Set(fb.likedIds || []),
    likedTitles: new Set((fb.likedTitles || []).map(normalizeTitle)),
    skippedIds: new Set(fb.skippedIds || []),
  };

  const scored: Scored[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();

  for (const c of candidates || []) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.title !== 'string' || !c.title) continue;
    if (hiddenIds.has(c.id)) continue;
    const nTitle = normalizeTitle(c.title);
    if (nTitle && hiddenTitles.has(nTitle)) continue;
    if (seenIds.has(c.id)) continue;
    if (nTitle && seenTitles.has(nTitle)) continue;
    seenIds.add(c.id);
    if (nTitle) seenTitles.add(nTitle);

    const s = scoreOne(c, ctx, sets);
    if (s) scored.push(s);
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ha = stableHash(`${ctx.seed}:${a.candidate.id}`);
    const hb = stableHash(`${ctx.seed}:${b.candidate.id}`);
    if (ha !== hb) return ha - hb;
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  });

  // Diversity: max cfg.diversityCap per primary artist, greedy in rank order.
  const countsByArtist = new Map<string, number>();
  const pass1: Scored[] = [];
  const overflow: Scored[] = [];
  for (const s of scored) {
    const key = primaryArtist(s.candidate);
    const used = countsByArtist.get(key) || 0;
    if (used < cfg.diversityCap) {
      countsByArtist.set(key, used + 1);
      pass1.push(s);
    } else {
      overflow.push(s);
    }
  }
  const ordered = [...pass1, ...overflow];
  for (const s of ordered) s.bucket = classifyBucket(s);

  const composed =
    ctx.discovery === false
      ? ordered
      : composeByBuckets(
          ordered,
          ctx.seed,
          typeof ctx.appetite === 'number' && Number.isFinite(ctx.appetite)
            ? ctx.appetite
            : cfg.appetite.default,
          typeof ctx.limit === 'number' && ctx.limit > 0 ? Math.floor(ctx.limit) : ordered.length,
          cfg,
        );

  return composed.map(({ candidate: c, score, reasons, bucket }) => ({
    feedId: `f_${stableHash(`${ctx.seed}|${c.id}`).toString(36)}`,
    id: c.id,
    title: c.title,
    artist: c.artist,
    albumArt: c.albumArt,
    duration: c.duration,
    source: c.source,
    provider: c.provider,
    availability: resolveAvailability(c),
    // Never show a negative score — penalties can sink, never invert.
    score: Math.max(0, round2(score)),
    reasons: (
      bucket === 'discovery' && reasons.length === 0
        ? [...reasons, { text: 'A fresh pick for you', w: 0.01 }]
        : reasons
    )
      .slice(0, 2)
      .map((r) => r.text),
    rank: c.rank,
    language: c.language || null,
    era: c.era || null,
    bucket,
    discovery: bucket === 'discovery',
  }));
}
