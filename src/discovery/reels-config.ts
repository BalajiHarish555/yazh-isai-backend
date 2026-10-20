/**
 * Tunable Reels/For-You ranking parameters.
 *
 * The scorer's starting hypothesis (weights, bucket mix, diversity cap,
 * repeat penalties, exploration appetite) ships as code defaults — but is
 * overridable per deployment via environment variables so weights can be
 * tuned from measured feedback without a redeploy of logic:
 *
 *   REELS_W_TASTE / REELS_W_BEHAVIOR / REELS_W_CONTEXT /
 *   REELS_W_RELEVANCE / REELS_W_DISCOVERY        (component weights, 0..10)
 *   REELS_BUCKET_FAMILIAR / REELS_BUCKET_SIMILAR / REELS_BUCKET_DISCOVERY
 *   REELS_DIVERSITY_CAP                          (max items per artist)
 *   REELS_APPETITE_DEFAULT / _MIN / _MAX         (exploration share)
 *   REELS_REPEAT_SESSION / _RECENT / _OLDER      (repeat penalties, ≤0)
 *
 * Values are clamped so a bad env value degrades to sane behaviour, never
 * to a broken feed. `resetReelsConfigForTests` lets specs re-read env.
 */

export interface ReelsScoringConfig {
  weights: {
    taste: number;
    behavior: number;
    context: number;
    relevance: number;
    discovery: number;
  };
  buckets: {
    familiar: number;
    similar: number;
    discovery: number;
  };
  diversityCap: number;
  appetite: { default: number; min: number; max: number };
  /** Negative points: just-heard (session / recent id / recent title). */
  repeatPenalties: { session: number; recent: number; older: number };
}

export const DEFAULT_REELS_CONFIG: ReelsScoringConfig = {
  weights: { taste: 3, behavior: 2.5, context: 1.5, relevance: 1.5, discovery: 1.5 },
  buckets: { familiar: 0.6, similar: 0.25, discovery: 0.15 },
  diversityCap: 3,
  appetite: { default: 0.15, min: 0.1, max: 0.3 },
  repeatPenalties: { session: -3, recent: -2.5, older: -1 },
};

const clampNum = (raw: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

const envNum = (key: string, lo: number, hi: number, fallback: number): number =>
  clampNum(process.env[key], lo, hi, fallback);

/** Negative penalty env (≤0): sign-normalize after parsing, then bound. */
const envNeg = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const n = typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return -Math.min(10, Math.abs(n));
};

let cached: ReelsScoringConfig | null = null;

export function getReelsConfig(): ReelsScoringConfig {
  if (cached) return cached;
  const d = DEFAULT_REELS_CONFIG;
  const min = envNum('REELS_APPETITE_MIN', 0.05, 0.45, d.appetite.min);
  const max = envNum('REELS_APPETITE_MAX', 0.05, 0.5, d.appetite.max);
  cached = {
    weights: {
      taste: envNum('REELS_W_TASTE', 0, 10, d.weights.taste),
      behavior: envNum('REELS_W_BEHAVIOR', 0, 10, d.weights.behavior),
      context: envNum('REELS_W_CONTEXT', 0, 10, d.weights.context),
      relevance: envNum('REELS_W_RELEVANCE', 0, 10, d.weights.relevance),
      discovery: envNum('REELS_W_DISCOVERY', 0, 10, d.weights.discovery),
    },
    buckets: {
      familiar: envNum('REELS_BUCKET_FAMILIAR', 0, 1, d.buckets.familiar),
      similar: envNum('REELS_BUCKET_SIMILAR', 0, 1, d.buckets.similar),
      discovery: envNum('REELS_BUCKET_DISCOVERY', 0, 1, d.buckets.discovery),
    },
    diversityCap: Math.round(envNum('REELS_DIVERSITY_CAP', 1, 10, d.diversityCap)),
    appetite: {
      default: clampNum(envNum('REELS_APPETITE_DEFAULT', 0.05, 0.5, d.appetite.default), min, max, d.appetite.default),
      min,
      max: Math.max(min, max),
    },
    repeatPenalties: {
      session: envNeg('REELS_REPEAT_SESSION', d.repeatPenalties.session),
      recent: envNeg('REELS_REPEAT_RECENT', d.repeatPenalties.recent),
      older: envNeg('REELS_REPEAT_OLDER', d.repeatPenalties.older),
    },
  };
  return cached;
}

/** Test hook: drop the memoized config so the next read re-parses env. */
export function resetReelsConfigForTests(): void {
  cached = null;
}
