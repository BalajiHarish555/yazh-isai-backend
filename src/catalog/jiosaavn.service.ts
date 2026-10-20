import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { desEcbDecrypt } from '../common/des';
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
      const raw = Buffer.from(encrypted, 'base64');
      if (raw.length === 0 || raw.length % 8 !== 0) return null;
      const text = Buffer.from(
        desEcbDecrypt([...MEDIA_KEY].map((c) => c.charCodeAt(0)), raw),
      ).toString('utf8');
      const cleaned = text.replace(/[\0\s]+$/g, '').trim();
      return cleaned || null;
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
    const headers = { 'User-Agent': UA, Referer: 'https://www.jiosaavn.com/' };
    const isFullAudio = (type: string, length: number) =>
      // Must be audio and plausibly a full song (>500KB), not an error page.
      type.includes('audio') && length > 500_000;
    // 1. Cheap HEAD check first.
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), 6000);
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: headController.signal,
        headers,
      });
      clearTimeout(headTimer);
      if (response.ok) {
        const type = response.headers.get('content-type') || '';
        const length = Number(response.headers.get('content-length') || '0');
        if (isFullAudio(type, length)) return true;
      }
    } catch {
      clearTimeout(headTimer);
    }
    // 2. Some CDNs reject or misreport HEAD — fall back to a 1KB ranged GET.
    // A 206 with a content-range (or an audio content-type) proves the URL
    // serves real bytes; an error page comes back 200 text/html instead.
    const getController = new AbortController();
    const getTimer = setTimeout(() => getController.abort(), 6000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: getController.signal,
        headers: { ...headers, Range: 'bytes=0-1023' },
      });
      clearTimeout(getTimer);
      if (!response.ok && response.status !== 206) return false;
      const type = response.headers.get('content-type') || '';
      if (type.includes('audio')) return true;
      return response.status === 206 && !!response.headers.get('content-range');
    } catch {
      clearTimeout(getTimer);
      return false;
    }
  }

  /**
   * Rewrite the decrypted `_<n>.mp4` CDN URL to a target bitrate tier.
   * Matches ANY tier suffix (not just `_96.mp4`) so URLs that arrive on
   * 48/96 still upgrade correctly; returns null when no tier pattern exists.
   */
  private tierUrl(raw: string, bitrate: number): string | null {
    if (!raw || !/_\d+\.mp4\b/i.test(raw)) return null;
    return raw.replace(/_\d+\.mp4\b/i, `_${bitrate}.mp4`);
  }

  /**
   * Pick the best VERIFIABLE bitrate tier for a decrypted CDN URL.
   *
   * The old ladder hard-gated 320 behind `more['320kbps']==='true'`, but the
   * flag is unreliable on older catalog entries whose 320 file exists — a
   * large share of plays silently dropped to 160. Now:
   *  - flag says 320  → trust it, verify 320 sequentially (fast path)
   *  - flag missing   → verify 320 and 160 IN PARALLEL and prefer 320;
   *                     verification (HEAD/ranged-GET) is the source of truth
   *  - saver          → 160 only, as before
   */
  private async resolveTieredStream(
    raw: string,
    quality: 'best' | 'saver',
    more: any,
    title: string,
    artists: string,
  ): Promise<SaavnStreamDetails | null> {
    const build = (streamUrl: string, bitrate: number): SaavnStreamDetails => ({
      streamUrl,
      bitrate,
      codec: 'AAC',
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      qualityLabel: bitrate === 320 ? '320kbps AAC (High)' : '160kbps AAC (Medium)',
      quality: bitrate === 320 ? 'high' : 'medium',
      isLossless: false,
      source: 'JioSaavn',
      title,
      artists,
    });
    const url160 = this.tierUrl(raw, 160);
    if (quality === 'saver') {
      if (!url160 || !(await this.verifyStream(url160).catch(() => false))) return null;
      return build(url160, 160);
    }
    const url320 = this.tierUrl(raw, 320);
    const flag320 = more?.['320kbps'] === 'true';
    if (url320 && url160 && !flag320) {
      // Flag missing/unreliable — race both tiers, prefer 320.
      const [ok320, ok160] = await Promise.all([
        this.verifyStream(url320).catch(() => false),
        this.verifyStream(url160).catch(() => false),
      ]);
      if (ok320) return build(url320, 320);
      if (ok160) return build(url160, 160);
      return null;
    }
    if (url320 && (flag320 || !url160)) {
      if (await this.verifyStream(url320).catch(() => false)) return build(url320, 320);
    }
    if (url160 && (await this.verifyStream(url160).catch(() => false))) return build(url160, 160);
    return null;
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
   * Resolve the best JioSaavn stream for a song. Tries 320kbps first (the
   * quality ceiling most songs hit), then falls back to 160kbps — a wrong
   * song at high bitrate is worse than the right song at 160kbps, so
   * callers fall back to YouTube only when both tiers fail to match.
   *
   * quality === 'saver' skips the 320 tier on purpose: ~160kbps uses half
   * the bandwidth and is indistinguishable on mobile speakers.
   */
  async getBestStream(
    title: string,
    artist: string,
    quality: 'best' | 'saver' = 'best',
  ): Promise<SaavnStreamDetails | null> {
    // The frontend sometimes bundles display metadata into the title
    // ("Minsara Kanna - Srinivaas & ... • A.R.RAHMAN VIBRATION • 6:20").
    // The bullet (•) is this app's own metadata separator — a real song
    // title never contains it — so cut the tail before matching. (The
    // artist side already does this in artistTokens; the title side did
    // not, which sank the token-overlap score below the threshold.)
    const rawTitle = (title || '').split('•')[0].trim();
    const cleanTitle = this.normalizeTitle(rawTitle);
    if (!cleanTitle) return null;
    const artistTokens = this.artistTokens(artist);
    const primary = this.primaryArtist(artist);

    const cacheKey = `saavn_stream_${quality}_${cleanTitle}_${artistTokens.slice(0, 2).join('_')}`;
    const cached = await this.cacheService.get<SaavnStreamDetails>(cacheKey);
    if (cached) {
      // Short-TTL negative sentinel (see below) — skip repeat upstream calls.
      if ((cached as any).__saavnMiss) return null;
      this.logger.log(`Saavn cache hit (${quality}): ${title} - ${artist}`);
      return cached;
    }

    // Tier selection (320 → 160, or 160-only under 'saver') happens in
    // resolveTieredStream — verification decides, not the metadata flag.
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
        // Score 3 = exact title OR (partial title + artist hit). The old
        // threshold of 4 required BOTH a strong title match AND an artist
        // hit, which rejected many correct songs whose Saavn metadata
        // differs slightly from the YouTube title (e.g. "(From "Master")"
        // suffixes, alternate transliterations).
        if (score < 3) continue;
        const more = item?.more_info || {};
        const encrypted: string = more.encrypted_media_url || '';
        if (!encrypted) continue;
        const raw = this.decryptMediaUrl(encrypted);
        if (!raw) continue;

        const details = await this.resolveTieredStream(
          raw,
          quality,
          more,
          item?.title || rawTitle,
          item?.subtitle || artist,
        );
        if (details) {
          await this.cacheService.set(cacheKey, details, 21600);
          this.logger.log(
            `Saavn ${details.bitrate}kbps match (score ${score}): ${item?.title}`,
          );
          return details;
        }
      }
    }

    this.logger.log(`No high-confidence Saavn match for: ${title} - ${artist}`);
    // Remember misses briefly (5 min) so repeated plays/searches for an
    // unmatchable track don't hammer the upstream API. Catalog gaps this
    // persistent are re-checked soon enough; successes cache for 6h.
    await this.cacheService.set(cacheKey, { __saavnMiss: true } as any, 300);
    return null;
  }

  /**
   * Resolve a stream directly from a JioSaavn song ID (the raw id that
   * trending/autoplay prefix with "saavn-"). Unlike getBestStream this
   * does no title search — the caller already knows the exact song.
   */
  async getStreamBySongId(
    songId: string,
    quality: 'best' | 'saver' = 'best',
  ): Promise<SaavnStreamDetails | null> {
    const cleanId = (songId || '').replace(/^saavn-/, '').trim();
    if (!cleanId || !/^[A-Za-z0-9_-]+$/.test(cleanId)) return null;

    const cacheKey = `saavn_stream_id_${quality}_${cleanId}`;
    const cached = await this.cacheService.get<SaavnStreamDetails>(cacheKey);
    if (cached) {
      if ((cached as any).__saavnMiss) return null;
      this.logger.log(`Saavn ID cache hit (${quality}): ${cleanId}`);
      return cached;
    }

    const data = await this.fetchJson(
      `${SAAVN_API}?__call=song.getDetails&cc=in&_format=json&_marker=0&api_version=4&ctx=web6dot0&pids=${encodeURIComponent(cleanId)}`,
    );
    const songs: any = data?.songs || data;
    const item: any = Array.isArray(songs) ? songs[0] : songs;
    const more = item?.more_info || {};
    const encrypted: string = more.encrypted_media_url || item?.encrypted_media_url || '';
    if (!encrypted) {
      await this.cacheService.set(cacheKey, { __saavnMiss: true } as any, 300);
      return null;
    }
    const raw = this.decryptMediaUrl(encrypted);
    if (!raw) {
      await this.cacheService.set(cacheKey, { __saavnMiss: true } as any, 300);
      return null;
    }

    const details = await this.resolveTieredStream(
      raw,
      quality,
      more,
      item?.title || '',
      item?.subtitle || '',
    );
    if (details) {
      await this.cacheService.set(cacheKey, details, 21600);
      this.logger.log(`Saavn ID ${details.bitrate}kbps resolved: ${cleanId}`);
      return details;
    }

    await this.cacheService.set(cacheKey, { __saavnMiss: true } as any, 300);
    return null;
  }

  private decodeEntities(s: string): string {
    return (s || '')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ');
  }

  private normName(s: string): string {
    return (s || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/[^a-z0-9\u0B80-\u0BFF ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Short stable hash so truncated cache keys can't collide. */
  private shortHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /** Persons (singers) listed in a bundled artist string. */
  private personNames(artist: string): string[] {
    const out: string[] = [];
    for (const part of (artist || '').split('•')[0].split(/[,;&|/]+/)) {
      const cleaned = part
        .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
        .trim();
      const norm = this.normName(cleaned);
      if (norm.length > 2) out.push(norm);
    }
    return [...new Set(out)];
  }

  /** Movie/album tail of a bundled artist string ("A, B • Maryan (OST)"). */
  private movieName(artist: string, subtitle = ''): string {
    const tails: string[] = [];
    const parts = (artist || '').split('•').slice(1);
    for (const p of parts) {
      const m = this.normName(p.replace(/\d{1,2}:\d{2}/g, ' '));
      if (m.length > 2) tails.push(m);
    }
    if (tails.length > 0) return tails[0];
    const sub = (subtitle || '').split(' - ')[1] || '';
    return this.normName(sub);
  }

  private singersOf(item: any): string[] {
    const names: string[] = [];
    const push = (n: string) => {
      const norm = this.normName(n);
      if (norm.length > 2 && !names.includes(norm)) names.push(norm);
    };
    const more = item?.more_info || {};
    for (const a of more.artistMap?.primary_artists || []) push(a?.name || '');
    for (const a of more.artistMap?.featured_artists || []) push(a?.name || '');
    for (const p of ((item?.subtitle || '').split(' - ')[0] || '').split(/[,;&|/]+/)) push(p);
    return names;
  }

  private directorOf(item: any): string {
    const more = item?.more_info || {};
    if (typeof more.music === 'string' && more.music.trim()) {
      return this.normName(more.music.split(',')[0]);
    }
    const artists = more.artistMap?.artists || [];
    const found = artists.find((a: any) => (a?.role || '').toLowerCase() === 'music');
    return this.normName(found?.name || '');
  }

  private movieOf(item: any): string {
    const more = item?.more_info || {};
    if (typeof more.album === 'string' && more.album.trim()) {
      return this.normName(more.album);
    }
    return this.movieName('', item?.subtitle || '');
  }

  /**
   * Related-track autoplay pool. First resolves the CURRENT song on Saavn
   * to learn its ground truth (movie, music director, singers), then ranks
   * candidates the way film-music listeners think: same movie first, then
   * same director, then shared singers, then language.
   */
  async getAutoplaySeeds(title: string, artist: string, limit = 10): Promise<any[]> {
    const cleanTitle = this.normalizeTitle(title);
    if (!cleanTitle) return [];
    const normArtist = this.normName(artist);
    const cacheKey = `saavn_autoplay_v4_${cleanTitle}_${normArtist.slice(0, 48)}_${this.shortHash(normArtist)}`;
    const cached = await this.cacheService.get<any[]>(cacheKey);
    if (cached && cached.length > 0) {
      this.logger.log(`Saavn autoplay cache hit: ${title} - ${artist}`);
      return cached.slice(0, limit);
    }

    const wantSingers = this.personNames(artist);
    const wantMovie = this.movieName(artist);
    const wantLang = /[\u0B80-\u0BFF]/.test(title || '') ? 'tamil' : '';
    const primary = this.primaryArtist(artist);

    const yearOf = (item: any): number => {
      const raw = String(item?.year || item?.more_info?.release_date || '').match(/\d{4}/);
      const y = raw ? parseInt(raw[0], 10) : 0;
      return y > 1900 && y < 2100 ? y : 0;
    };

    // Ground truth for the current track: movie + director + singers + era + language.
    let refMovie = wantMovie;
    let refDirector = '';
    let refSingers = wantSingers;
    let refYear = 0;
    let refLang = '';
    try {
      const refData = await this.fetchJson(
        `${SAAVN_API}?__call=search.getResults&q=${encodeURIComponent(`${cleanTitle} ${primary}`.trim())}&p=1&n=3&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
      );
      const refResults: any[] = refData?.results || [];
      const refRanked = refResults
        .map((item) => ({ item, score: this.scoreCandidate(item, cleanTitle, this.artistTokens(artist)) }))
        .sort((a, b) => b.score - a.score);
      const ref = refRanked.length > 0 && refRanked[0].score >= 4 ? refRanked[0].item : null;
      if (ref) {
        const m = this.movieOf(ref);
        if (m) refMovie = m;
        const d = this.directorOf(ref);
        if (d) refDirector = d;
        const s = this.singersOf(ref);
        if (s.length > 0) refSingers = s;
        const y = yearOf(ref);
        if (y) refYear = y;
        const rl = String(ref?.language || '').toLowerCase();
        if (rl && rl !== 'unknown' && rl !== 'other') refLang = rl;
      }
    } catch {
      // Reference lookup is an optimization; matching still works without it.
    }

    const queries = primary ? [`${primary} top songs`, primary] : [cleanTitle];
    if (refMovie) queries.push(refMovie);
    const scored: Array<{ entry: any; score: number }> = [];
    const seen = new Set<string>();
    for (const q of queries.slice(0, 3)) {
      const data = await this.fetchJson(
        `${SAAVN_API}?__call=search.getResults&q=${encodeURIComponent(q)}&p=1&n=10&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
      );
      const results: any[] = data?.results || [];
      for (const item of results) {
        const itemTitle = this.normalizeTitle(item?.title || '');
        if (!itemTitle || itemTitle === cleanTitle || seen.has(itemTitle)) continue;
        seen.add(itemTitle);
        const more = item?.more_info || {};
        const primaries: string[] = (more.artistMap?.primary_artists || []).map((a: any) => a?.name).filter(Boolean);
        const artists = primaries.length > 0
          ? primaries.join(', ')
          : (item?.subtitle || '').split(' - ')[0].split('•')[0].trim();
        let score = 0;
        let reason = '';
        const displayCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
        // Same movie/album: the strongest film-music signal.
        if (refMovie && this.movieOf(item) === refMovie) {
          score += 5;
          reason = `More from ${displayCase(refMovie)}`;
        }
        // Same music director.
        if (refDirector && this.directorOf(item) === refDirector) {
          score += 4;
          if (!reason) reason = `More by ${displayCase(refDirector)}`;
        }
        // Shared singers.
        const gotSingers = this.singersOf(item);
        let singerHits = 0;
        let sharedSinger = '';
        for (const s of refSingers) {
          if (gotSingers.includes(s) && singerHits < 2) {
            singerHits++;
            if (!sharedSinger) sharedSinger = s;
          }
        }
        if (singerHits === 0) {
          const haystack = `${itemTitle} ${gotSingers.join(' ')}`;
          for (const token of this.artistTokens(artist)) {
            if (token.length > 2 && haystack.includes(token)) {
              singerHits = 1;
              break;
            }
          }
        }
        score += singerHits * 2;
        // Strict language filter: match the seed song's own language, learned
        // from the resolved reference track (input titles are usually Latin
        // script, so script-sniffing the query alone misses Tamil seeds).
        const seedLang = refLang || wantLang;
        const lang = (item?.language || '').toLowerCase();
        if (seedLang && lang && lang !== seedLang && lang !== 'unknown' && lang !== 'other') {
          continue;
        }
        if (seedLang && lang === seedLang) score += 3;
        // Same era: film-music taste clusters by generation (±3y strong).
        const candYear = yearOf(item);
        if (refYear && candYear) {
          const gap = Math.abs(refYear - candYear);
          if (gap <= 3) score += 2;
          else if (gap <= 7) score += 1;
        }
        if (score < 2) continue;
        if (!reason) {
          reason = sharedSinger
            ? `More from ${displayCase(sharedSinger)}`
            : seedLang
              ? `Similar ${seedLang} songs`
              : 'Similar songs';
        }
        const entry: any = {
          id: `saavn-${item.id}`,
          title: this.decodeEntities((item?.title || '').trim()),
          artists: artists || 'Unknown Artist',
          thumbnail: (item?.image || '').replace('150x150', '500x500').replace('50x50', '500x500'),
          source: 'Autoplay • JioSaavn',
          reason,
        };
        // Attach a verified-quality stream URL when the track offers 320.
        if (more['320kbps'] === 'true' && more.encrypted_media_url) {
          const raw = this.decryptMediaUrl(more.encrypted_media_url);
          const url320 = raw ? raw.replace('_96.mp4', '_320.mp4') : null;
          if (url320 && url320 !== raw) {
            entry.streamUrl = url320;
            entry.audioQuality = '320kbps AAC (High)';
          }
        }
        scored.push({ entry, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const out = scored.slice(0, limit).map((s) => s.entry);
    if (out.length > 0) {
      await this.cacheService.set(cacheKey, out, 3600);
    }
    return out;
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

  /** Language keywords for matching chart playlists to the listener. */
  private static readonly CHART_LANG_KEYS: Record<string, string[]> = {
    tamil: ['tamil', 'kollywood'],
    hindi: ['hindi', 'bollywood'],
    telugu: ['telugu', 'tollywood'],
    malayalam: ['malayalam', 'mollywood'],
    kannada: ['kannada', 'sandalwood'],
    english: ['english', 'hollywood', 'pop', 'top 40'],
  };

  /**
   * Real trending data from Saavn's trending/chart playlists. Set `stable`
   * for chart-style ranked output (same order until the 15-min cache turns
   * over); default shuffles so casual visits look fresh. `lang` prefers
   * playlists matching the listener's language (tamil/hindi/...) so Tamil
   * users get Kollywood charts, not Bollywood ones.
   * Cached briefly (15 min) — trends move, but not second-to-second.
   */
  async getTrendingSongs(limit = 12, opts: { stable?: boolean; lang?: string } = {}): Promise<any[]> {
    const langKeys = JioSaavnService.CHART_LANG_KEYS[(opts.lang || '').toLowerCase()] || [];
    const cacheKey = `saavn_charts_v2_${langKeys[0] || 'mix'}`;
    const cached = await this.cacheService.get<any[]>(cacheKey);
    const pool: any[] = cached || [];
    const collectFrom = async (lists: any[], collected: any[]) => {
      for (const pl of lists.slice(0, 2)) {
        if (!pl?.id) continue;
        const details = await this.fetchJson(
          `${SAAVN_API}?__call=playlist.getDetails&listid=${pl.id}&p=1&n=30&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
        );
        const songs: any[] = details?.list || [];
        for (const s of songs) {
          const mapped = this.mapTrendingSong(s);
          const key = mapped ? this.normalizeTitle(mapped.title) : '';
          if (mapped && key && !collected.some((c) => this.normalizeTitle(c.title) === key)) {
            collected.push(mapped);
          }
        }
        if (collected.length >= limit * 2) break;
      }
    };
    if (pool.length === 0) {
      const collected: any[] = [];
      // Saavn's own charts shelf is Hindi-only and its search surface is
      // song-dominated, so for other languages build the chart straight
      // from song search ranked by play count — a genuine popularity chart.
      if (langKeys.length > 0) {
        try {
          const sq = await this.fetchJson(
            `${SAAVN_API}?__call=search.getResults&q=${encodeURIComponent(`${langKeys[0]} top songs`)}&p=1&n=30&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
          );
          const found: any[] = sq?.results || [];
          const langSongs = found
            .filter(
              (x) =>
                x?.type === 'song' &&
                String(x?.language || '').toLowerCase() === langKeys[0],
            )
            .sort((a, b) => Number(b?.play_count || 0) - Number(a?.play_count || 0));
          for (const s of langSongs) {
            const mapped = this.mapTrendingSong(s);
            // "(From ...)" variants of the same song share a normalized
            // title — keep only the highest-play-count one.
            const key = mapped ? this.normalizeTitle(mapped.title) : '';
            if (mapped && key && !collected.some((c) => this.normalizeTitle(c.title) === key)) {
              collected.push(mapped);
            }
            if (collected.length >= limit * 2) break;
          }
        } catch {
          // Fall through to the generic trending shelf.
        }
      }
      if (collected.length === 0) {
        const data = await this.fetchJson(
          `${SAAVN_API}?__call=content.getTrending&_format=json&_marker=0&api_version=4&ctx=web6dot0`,
        );
        const items: any[] = Array.isArray(data) ? data : [];
        const lists = items.filter((x) => x?.type === 'playlist');
        // Prefer the listener's language first ("Tamil Hits" over "Now
        // Trending"), then explicitly-trending playlists. Take up to two.
        const langHit = (x: any) =>
          langKeys.some((k) => (x?.title || '').toLowerCase().includes(k)) ? 0 : 1;
        lists.sort((a, b) => {
          const dl = langHit(a) - langHit(b);
          if (dl !== 0) return dl;
          const score = (x: any) => (/trend|chart|top/i.test(x?.title || '') ? 0 : 1);
          return score(a) - score(b);
        });
        await collectFrom(lists, collected);
      }
      if (collected.length === 0) {
        this.logger.warn('Saavn trending returned no songs');
        return [];
      }
      await this.cacheService.set(cacheKey, collected, 900);
      pool.push(...collected);
    }
    if (opts.stable) {
      // Chart mode: rank order is meaningful, keep it.
      return pool.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
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
