import { describe, expect, it } from 'vitest';
import { JioSaavnService } from './jiosaavn.service';
import { CacheService } from '../common/cache.service';
import { desEcbDecrypt, hexToBytes } from '../common/des';

// Captured live 2026-10-10: must keep decrypting to the same URL forever.
const VECTOR_ENCRYPTED =
  'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDy5gm7kSbU1erB9FiLKA43q4eJvc6J4C4tYhE8W8/T3ZcMKZkRNwNZHRw7tS9a8Gtq';
const VECTOR_PLAIN = 'https://aac.saavncdn.com/525/fe0acac4728484d5c85bfc2e51d8d165_96.mp4';

describe('DES-ECB primitive', () => {
  it('matches the FIPS known-answer test', () => {
    // Key 133457799BBCDFF1, ciphertext 85E813540F0AB405.
    // Plaintext 0123456789ABCDEF ends in 0xEF (>8), so no unpadding occurs.
    const out = desEcbDecrypt(
      hexToBytes('133457799BBCDFF1'),
      hexToBytes('85E813540F0AB405'),
    );
    expect(Buffer.from(out).toString('hex').toUpperCase()).toBe('0123456789ABCDEF');
  });
});

describe('JioSaavnService (pure logic, no network)', () => {
  const svc = new JioSaavnService(new CacheService());

  it('decrypts a captured media URL to the exact CDN address', () => {
    expect((svc as any).decryptMediaUrl(VECTOR_ENCRYPTED)).toBe(VECTOR_PLAIN);
  });

  it('rejects garbage without throwing', () => {
    expect((svc as any).decryptMediaUrl('!!!not-base64!!!')).toBeNull();
    expect((svc as any).decryptMediaUrl('')).toBeNull();
  });

  it('normalizes titles for matching (brackets, feat, case)', () => {
    const norm = (s: string) => (svc as any).normalizeTitle(s);
    expect(norm('Innum Konjam Neram (From "Maryan")')).toBe('innum konjam neram');
    expect(norm('Hukum - Thalaivar Alappara [Official Video]')).toBe('hukum thalaivar alappara');
  });

  it('splits bundled artist strings into tokens', () => {
    const tokens = (svc as any).artistTokens('A.R. Rahman, Vijay Prakash & Shweta Mohan • Maryan');
    expect(tokens).toContain('a r rahman');
    expect(tokens).toContain('vijay prakash');
    expect(tokens).toContain('shweta mohan');
  });

  it('rewrites CDN URLs to any bitrate tier (robust to non-96 raws)', () => {
    const url = (n: number) => (svc as any).tierUrl(VECTOR_PLAIN, n);
    expect(url(320)).toBe('https://aac.saavncdn.com/525/fe0acac4728484d5c85bfc2e51d8d165_320.mp4');
    expect(url(160)).toContain('_160.mp4');
    // Raw URLs on a different base tier still upgrade.
    const raw48 = 'https://aac.saavncdn.com/abc/xyz_48.mp4';
    expect((svc as any).tierUrl(raw48, 320)).toContain('_320.mp4');
    // Query-string suffixes survive the rewrite.
    expect((svc as any).tierUrl(VECTOR_PLAIN + '?sig=abc', 320)).toContain('_320.mp4?sig=abc');
    // No tier pattern → null (caller falls through to next source).
    expect((svc as any).tierUrl('https://x/no-tier.mp4', 320)).toBeNull();
    expect((svc as any).tierUrl('', 320)).toBeNull();
  });
});
