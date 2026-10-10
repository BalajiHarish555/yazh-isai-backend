import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import * as forge from 'node-forge';
import { CacheService } from '../common/cache.service';

export interface SaavnStreamDetails {
  streamUrl: string;
  bitrate: number;
  codec: string;
  mimeType: string;
  qualityLabel: string;
  quality: 'high' | 'medium' | 'low';
  isLossless: boolean;
  source: string;
  title: string;
  artists: string;
}

const SAAVN_API = 'https://www.jiosaavn.com/api.php';
// Key used by JioSaavn's web client to encrypt media URLs (DES-ECB).
const MEDIA_KEY = '38346591';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

@Injectable()
export class JioSaavnService {
  private readonly logger = new Logger(JioSaavnService.name);

  constructor(private cacheService: CacheService) {}

  private normalizeTitle(title: string): string {
    return (title || '')
      .replace(/&quot;|&#0*39;|&amp;/g, ' ')
      .replace(/\s*\(From.*?\)/gi, ' ')
      .replace(/\s*\[.*?\]/g, ' ')
      .replace(/[^a-z0-9\u0B80-\u0BFF ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private artistTokens(artist: string): string[] {
    return (artist || '')
      .split('•')[0]
      .split(/[,;&|/]+/)
      .flatMap((p) => p.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i))
      .map((p) => p.replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((p) => p.length > 2);
  }

  private primaryArtist(artist: string): string {
    const tokens = this.artistTokens(artist);
    return tokens[0] || '';
  }

  private decryptMediaUrl(encrypted: string): string | null {
    try {
      const decipher = forge.cipher.createDecipher('DES-ECB', forge.util.createBuffer(MEDIA_KEY));
      decipher.start({ iv: '' } as any);
      decipher.update(forge.util.createBuffer(forge.util.decode64(encrypted)));
      const ok = decipher.finish();
      if (!ok) return null;
      return decipher.output.toString().trim() || null;
    } catch (error: any) {
      this.logger.log(`Saavn URL decrypt failed: ${error?.message || error}`);
      return null;
    }
  }

  private async fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.jiosaavn.com/' },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error: any) {
      this.logger.log(`Saavn request failed: ${error?.message || error}`);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async verifyStream(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.jiosaavn.com/' },
      });
      clearTimeout(timeoutId);
      if (!response.ok) return false;
      const type = response.headers.get('content-type') || '';
      const length = Number(response.headers.get('content-length') || '0');
      // Must be audio and plausibly a full song (>500KB), not an error page.
      return type.includes('audio') && length > 500_000;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  }

  private scoreCandidate(
    item: any,
    wantTitle: string,
    wantArtistTokens: string[],
  ): number {
    const clean = (s: string) =>
      (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0B80-\u0BFF ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const gotTitle = this.normalizeTitle(item?.title || '');
    // Strip punctuation on BOTH sides: "A.R. Rahman" (query) must match
    // "A.R. Rahman" (subtitle) after the same normalization.
    const gotText = `${gotTitle} ${clean(item?.subtitle || '')} ${clean(item?.more_info?.music || '')}`;
    let titleScore = 0;
    if (gotTitle && wantTitle) {
      if (gotTitle === wantTitle) titleScore = 3;
      else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) titleScore = 2;
      else {
        const wantTokens = new Set(wantTitle.split(' ').filter((t) => t.length > 2));
        const gotTokens = new Set(gotTitle.split(' ').filter((t) => t.length > 2));
        let overlap = 0;
        for (const t of wantTokens) if (gotTokens.has(t)) overlap++;
        if (wantTokens.size > 0 && overlap / wantTokens.size >= 0.6) titleScore = 1;
      }
    }
    let artistScore = 0;
    for (const token of wantArtistTokens) {
      if (token.length > 2 && gotText.includes(token)) {
        artistScore = 2;
        break;
      }
    }
    return titleScore + artistScore;
  }

  /**
   * Resolve the best JioSaavn stream for a song. Only returns a result when
   * a high-confidence match offers verified 320kbps — a wrong song at high
   * bitrate is worse than the right song at 160kbps, so callers fall back
   * to YouTube on null.
   */
  async getBestStream(title: string, artist: string): Promise<SaavnStreamDetails | null> {
    const cleanTitle = this.normalizeTitle(title);
    if (!cleanTitle) return null;
    const artistTokens = this.artistTokens(artist);
    const primary = this.primaryArtist(artist);

    const cacheKey = `saavn_stream_${cleanTitle}_${artistTokens.slice(0, 2).join('_')}`;
    const cached = await this.cacheService.get<SaavnStreamDetails>(cacheKey);
    if (cached) {
      this.logger.log(`Saavn cache hit: ${title} - ${artist}`);
      return cached;
    }

    const queries = primary ? [`${cleanTitle} ${primary}`, cleanTitle] : [cleanTitle];
    for (const q of queries.slice(0, 2)) {
      const data = await this.fetchJson(
        `${SAAVN_API}?__call=search.getResults&q=${encodeURIComponent(q)}&p=1&n=5&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
      );
      const results: any[] = data?.results || [];
      const ranked = results
        .map((item) => ({ item, score: this.scoreCandidate(item, cleanTitle, artistTokens) }))
        .sort((a, b) => b.score - a.score);

      for (const { item, score } of ranked) {
        // Title must strongly match AND at least one artist token must hit.
        if (score < 4) continue;
        const more = item?.more_info || {};
        if (more['320kbps'] !== 'true') continue;
        const encrypted: string = more.encrypted_media_url || '';
        if (!encrypted) continue;
        const raw = this.decryptMediaUrl(encrypted);
        if (!raw) continue;
        const url320 = raw.replace('_96.mp4', '_320.mp4');
        if (url320 === raw) continue;
        if (!(await this.verifyStream(url320))) {
          this.logger.log(`Saavn 320 URL failed verification for: ${item?.title}`);
          continue;
        }
        const details: SaavnStreamDetails = {
          streamUrl: url320,
          bitrate: 320,
          codec: 'AAC',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          qualityLabel: '320kbps AAC (High)',
          quality: 'high',
          isLossless: false,
          source: 'JioSaavn',
          title: item?.title || title,
          artists: item?.subtitle || artist,
        };
        await this.cacheService.set(cacheKey, details, 21600);
        this.logger.log(`Saavn 320kbps match (score ${score}): ${item?.title}`);
        return details;
      }
    }

    this.logger.log(`No high-confidence Saavn 320 match for: ${title} - ${artist}`);
    return null;
  }

  private decodeEntities(s: string): string {
    return (s || '')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ');
  }

  private mapTrendingSong(item: any): {
    id: string;
    title: string;
    artists: string;
    thumbnail: string;
    duration?: number;
    source: string;
  } | null {
    const title = this.decodeEntities((item?.title || '').trim());
    if (!title) return null;
    const primaries: string[] = (
      item?.more_info?.artistMap?.primary_artists || []
    )
      .map((a: any) => a?.name)
      .filter(Boolean);
    const artists =
      primaries.length > 0 ? primaries.join(', ') : (item?.subtitle || '').split(' - ')[0].trim() || 'Unknown Artist';
    // c.saavncdn.com serves multiple sizes; 500px suits cards + player art.
    const thumbnail = (item?.image || '').replace('150x150', '500x500').replace('50x50', '500x500');
    const duration = Number(item?.more_info?.duration || item?.duration || 0) || undefined;
    return {
      id: `saavn-${item.id}`,
      title,
      artists,
      thumbnail,
      duration,
      source: 'Trending • JioSaavn',
    };
  }

  /**
   * Real trending data: Saavn's trending playlists ("Now Trending",
   * "Trending Today"), shuffled on every call so each visit looks fresh.
   * Cached briefly (15 min) — trends move, but not second-to-second.
   */
  async getTrendingSongs(limit = 12): Promise<any[]> {
    const cacheKey = 'saavn_trending_songs';
    const cached = await this.cacheService.get<any[]>(cacheKey);
    // Serve cache but reshuffle: content stays fresh for 15 min, order is
    // always new.
    const pool: any[] = cached || [];
    if (pool.length === 0) {
      const data = await this.fetchJson(
        `${SAAVN_API}?__call=content.getTrending&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
      );
      const items: any[] = Array.isArray(data) ? data : [];
      const lists = items.filter((x) => x?.type === 'playlist');
      // Prefer explicitly-trending playlists, take up to two for variety.
      lists.sort((a, b) => {
        const score = (x: any) => (/trend/i.test(x?.title || '') ? 0 : 1);
        return score(a) - score(b);
      });
      const collected: any[] = [];
      for (const pl of lists.slice(0, 2)) {
        const details = await this.fetchJson(
          `${SAAVN_API}?__call=playlist.getDetails&listid=${pl.id}&p=1&n=30&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
        );
        const songs: any[] = details?.list || [];
        for (const s of songs) {
          const mapped = this.mapTrendingSong(s);
          if (mapped && !collected.some((c) => c.title === mapped.title)) collected.push(mapped);
        }
        if (collected.length >= limit * 2) break;
      }
      if (collected.length === 0) {
        this.logger.warn('Saavn trending returned no songs');
        return [];
      }
      await this.cacheService.set(cacheKey, collected, 900);
      pool.push(...collected);
    }
    // Fisher-Yates shuffle a copy — fresh order on every call.
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, limit);
  }
}
