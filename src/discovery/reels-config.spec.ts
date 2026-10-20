import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_REELS_CONFIG,
  getReelsConfig,
  resetReelsConfigForTests,
} from './reels-config';

const ENV_KEYS = [
  'REELS_W_TASTE',
  'REELS_W_BEHAVIOR',
  'REELS_W_CONTEXT',
  'REELS_W_RELEVANCE',
  'REELS_W_DISCOVERY',
  'REELS_BUCKET_FAMILIAR',
  'REELS_BUCKET_SIMILAR',
  'REELS_BUCKET_DISCOVERY',
  'REELS_DIVERSITY_CAP',
  'REELS_APPETITE_DEFAULT',
  'REELS_APPETITE_MIN',
  'REELS_APPETITE_MAX',
  'REELS_REPEAT_SESSION',
  'REELS_REPEAT_RECENT',
  'REELS_REPEAT_OLDER',
];

describe('reels-config', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetReelsConfigForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetReelsConfigForTests();
  });

  it('defaults match the shipped hypothesis when env is unset', () => {
    expect(getReelsConfig()).toEqual(DEFAULT_REELS_CONFIG);
  });

  it('memoizes until reset', () => {
    const a = getReelsConfig();
    process.env.REELS_W_TASTE = '5';
    expect(getReelsConfig().weights.taste).toBe(3); // still memoized
    resetReelsConfigForTests();
    expect(getReelsConfig().weights.taste).toBe(5);
  });

  it('honours env overrides', () => {
    process.env.REELS_W_TASTE = '4.5';
    process.env.REELS_BUCKET_DISCOVERY = '0.25';
    process.env.REELS_DIVERSITY_CAP = '2';
    process.env.REELS_APPETITE_DEFAULT = '0.2';
    process.env.REELS_REPEAT_SESSION = '-4';
    const cfg = getReelsConfig();
    expect(cfg.weights.taste).toBe(4.5);
    expect(cfg.buckets.discovery).toBe(0.25);
    expect(cfg.diversityCap).toBe(2);
    expect(cfg.appetite.default).toBe(0.2);
    expect(cfg.repeatPenalties.session).toBe(-4);
  });

  it('clamps garbage env values into sane bands', () => {
    process.env.REELS_W_TASTE = '9999';
    process.env.REELS_W_BEHAVIOR = 'not-a-number';
    process.env.REELS_DIVERSITY_CAP = '-7';
    process.env.REELS_APPETITE_MIN = '0.9';
    process.env.REELS_APPETITE_MAX = '0.2'; // min > max → max follows min
    process.env.REELS_REPEAT_RECENT = '3'; // sign forced negative
    const cfg = getReelsConfig();
    expect(cfg.weights.taste).toBeLessThanOrEqual(10);
    expect(cfg.weights.behavior).toBe(DEFAULT_REELS_CONFIG.weights.behavior);
    expect(cfg.diversityCap).toBeGreaterThanOrEqual(1);
    expect(cfg.appetite.min).toBeLessThanOrEqual(cfg.appetite.max);
    expect(cfg.repeatPenalties.recent).toBeLessThanOrEqual(0);
  });

  it('keeps appetite.default inside [min, max]', () => {
    process.env.REELS_APPETITE_MIN = '0.2';
    process.env.REELS_APPETITE_MAX = '0.25';
    process.env.REELS_APPETITE_DEFAULT = '0.1'; // below min → clamped up
    expect(getReelsConfig().appetite.default).toBeCloseTo(0.2, 5);
  });
});
