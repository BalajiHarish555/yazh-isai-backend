import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import * as crypto from 'crypto';
import { CacheService } from '../common/cache.service';
import { Blowfish, deezerBlowfishKey } from './blowfish';

/**
 * Deezer FLAC resolver — the same engine that powers Monochrome's "Deezer
 * Fallback", but self-hosted so we don't depend on their (currently down)
 * public proxy. Authenticated with YOUR Deezer account's ARL cookie:
 *
 *   1. deezer.getUserData(ARL)  -> license_token (+ can_stream_lossless)
 *   2. song.getListData(ids)    -> TRACK_TOKEN, MD5_ORIGIN, FILESIZE_FLAC
 *   3. media.deezer.com/v1/get_url(license_token, track_tokens, FLAC)
 *                                 -> direct CDN url (BF_CBC_STRIPE encrypted)
 *
 * The returned FLAC url is Blowfish-CBC stripe-encrypted (every 3rd 2048-byte
 * chunk; the other two are plaintext). Each stripe decrypts independently with
 * a fixed IV, so a Range-supporting decrypting proxy is possible — see
 * DeezerStreamController.
 */

export interface DeezerFlacDetails {
  streamUrl: string;
  trackId: string;
  /** Our decrypting-proxy URL (stable, same-origin) — prefer this for playback. */
  proxyUrl: string;
  bitrate: number;
  codec: string;
  mimeType: string;
  qualityLabel: string;
  quality: 'high' | 'medium' | 'low';
  isLossless: boolean;
  source: string;
  title: string;
  artists: string;
  isEncrypted: boolean;
  fileSize: number;
  duration: number;
  isrc?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const md5 = (s: string) => crypto.createHash('md5').update(s, 'ascii').digest('hex');

@Injectable()
export class DeezerService {
  private readonly logger = new Logger(DeezerService.name);

  // Session cache (license token + api token). Refreshed when it expires.
  private session: {
    licenseToken: string;
    apiToken: string;
    canLossless: boolean;
    country: string;
    at: number;
  } | null = null;

  // Circuit breaker for the external fallback proxy. After 3 consecutive
  // failures the fallback is skipped for 5 minutes so every song request
  // doesn't burn a 10-second timeout against a dead upstream.
  private fallbackFailCount = 0;
  private fallbackOpenUntil = 0;

  // Set when the ARL comes back anonymous (USER_ID=0) — avoids re-running
  // getUserData on every track for the next 10 minutes.
  private arlInvalidUntil = 0;

  constructor(private cacheService: CacheService) {}

  /** The ARL account cookie. Read from env so no secret is ever committed. */
  private getArl(): string {
    return (process.env.DEEZER_ARL || '').trim();
  }

  /** Whether FLAC playback is configured at all. */
  isEnabled(): boolean {
    return this.getArl().length > 0;
  }

  /** Whether Deezer fallback is enabled. */
  isFallbackEnabled(): boolean {
    return (
      process.env.DEEZER_FALLBACK_ENABLED === 'true' &&
      !!process.env.DEEZER_FALLBACK_API_BASE_URL
    );
  }

  /**
   * Attempt to resolve a track via the Deezer fallback service.
   * Used when the primary Deezer ARL-based approach fails.
   */
  private async resolveViaFallback(
    title: string,
    artist: string
  ): Promise<DeezerFlacDetails | null> {
    if (!this.isFallbackEnabled()) return null;
    if (!title) return null;

    // Circuit breaker: after 3 consecutive failures skip the fallback for
    // 5 minutes so dead upstreams don't add 10s latency to every request.
    if (Date.now() < this.fallbackOpenUntil) return null;

    const apiBase = process.env.DEEZER_FALLBACK_API_BASE_URL ||
      'https://dzr.tabs-vs-spaces.wtf';
    const query = `${title} ${artist}`.trim();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `${apiBase}/search?q=${encodeURIComponent(query)}&limit=1`,
        {
          headers: { 'User-Agent': UA },
          signal: controller.signal,
        }
      );
      clearTimeout(timer);

      if (!res.ok) {
        this.logger.warn(
          `Deezer fallback request failed: ${res.status} ${res.statusText}`
        );
        this.fallbackFailCount++;
        if (this.fallbackFailCount >= 3) {
          this.fallbackOpenUntil = Date.now() + 5 * 60 * 1000;
          this.logger.warn('Deezer fallback circuit open — skipping for 5 min');
        }
        return null;
      }
      this.fallbackFailCount = 0;

      const data = await res.json() as any;
      const track = (data.data?.[0] as any) || (data.track as any) || (data as any);
      if (!track) return null;

      // Assume the fallback service returns a direct FLAC URL or similar
      const flacUrl = (track.url as string) || (track.download_url as string) || (track.stream_url as string);
      if (!flacUrl) return null;

      // Try to get more details if available
      const detailRes = await fetch(
        `${apiBase}/track/${(track.id as string)}`,
        { headers: { 'User-Agent': UA } }
      );
      let detailData: any = {};
      if (detailRes.ok) {
        detailData = await detailRes.json();
      }

      return {
        streamUrl: flacUrl,
        trackId: String(track.id),
        proxyUrl: flacUrl, // For now, use direct URL; could proxy later
        bitrate: (detailData.bitrate as number) || 1411,
        codec: (detailData.codec as string) || 'FLAC',
        mimeType: (detailData.mimeType as string) || 'audio/flac',
        qualityLabel: (detailData.qualityLabel as string) ||
          'FLAC 16-bit/44.1kHz (Lossless)',
        quality: 'high' as const,
        isLossless: true,
        source: 'Deezer Fallback',
        title: (track.title as string) || title,
        artists: (track.artist as string) || artist,
        isEncrypted: false, // Assume fallback provides ready-to-play URL
        fileSize: (detailData.fileSize as number) || 0,
        duration: (detailData.duration as number) || (track.duration as number) || 0,
        isrc: (track.isrc as string) || undefined,
      };
    } catch (err: any) {
      this.logger.warn(`Deezer fallback failed: ${err.message || err}`);
      this.fallbackFailCount++;
      if (this.fallbackFailCount >= 3) {
        this.fallbackOpenUntil = Date.now() + 5 * 60 * 1000;
        this.logger.warn('Deezer fallback circuit open — skipping for 5 min');
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- session

  private async gwCall<T = any>(
    method: string,
    body: Record<string, unknown>,
    apiToken = 'null',
  ): Promise<T | null> {
    const arl = this.getArl();
    if (!arl) return null;
    const url = `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${apiToken}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Cookie: `arl=${arl}`,
          Origin: 'https://www.deezer.com',
          Referer: 'https://www.deezer.com/',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json: any = await res.json();
      // gw-light returns `error: []` on success — an empty array is truthy,
      // so check for actual entries (object with keys, or non-empty array).
      const err = json?.error;
      const hasError =
        err != null &&
        (Array.isArray(err)
          ? err.length > 0
          : typeof err === 'object'
            ? Object.keys(err).length > 0
            : !!err);
      if (hasError) {
        this.logger.warn(`Deezer gw ${method} error: ${JSON.stringify(err)}`);
        return null;
      }
      return (json?.results ?? null) as T | null;
    } catch (err: any) {
      this.logger.warn(`Deezer gw ${method} failed: ${err?.message || err}`);
      return null;
    }
  }

  /** Fetch (and cache for 1h) the license token needed by media.deezer.com. */
  private async ensureSession(): Promise<typeof this.session> {
    if (this.session && Date.now() - this.session.at < 60 * 60 * 1000) return this.session;
    // A bad ARL comes back as an ANONYMOUS session (USER_ID 0) with a guest
    // license token that has no FLAC rights. Don't re-detect it per track —
    // back off for 10 minutes and log it once.
    if (Date.now() < this.arlInvalidUntil) return null;
    const results = await this.gwCall<any>('deezer.getUserData', {});
    if (!results) return null;
    const userId = results?.USER?.USER_ID;
    if (!userId) {
      this.arlInvalidUntil = Date.now() + 10 * 60 * 1000;
      this.logger.warn(
        'Deezer ARL invalid or expired (anonymous session, USER_ID=0) — set a fresh DEEZER_ARL from a logged-in browser session',
      );
      return null;
    }
    const opts = results?.USER?.OPTIONS || {};
    const licenseToken = opts.license_token;
    if (!licenseToken) {
      this.logger.warn('Deezer getUserData returned no license_token (bad ARL?)');
      return null;
    }
    // checkForm is the per-session api_token that song.getListData requires —
    // passing 'null' there makes the call silently return no data.
    const apiToken = results?.checkForm || 'null';
    this.session = {
      licenseToken,
      apiToken,
      canLossless: !!(opts.web_lossless || opts.mobile_loseless),
      country: results?.COUNTRY || 'XX',
      at: Date.now(),
    };
    if (!this.session.canLossless) {
      this.logger.warn(
        `Deezer account ${userId} has no lossless entitlement (country ${this.session.country}) — FLAC unavailable, skipping Deezer lane`,
      );
    } else {
      this.logger.log(
        `Deezer session ready (lossless=true, country=${this.session.country})`,
      );
    }
    return this.session;
  }

  // ------------------------------------------------------------ ISRC lookup

  /**
   * Find the Deezer track id for a title/artist. Uses Deezer's public ISRC
   * endpoint (no ARL needed) via MusicBrainz, which is reliable for
   * commercial releases including Tamil film songs.
   */
  private async lookupTrackByIsrc(isrc: string): Promise<{ id: string; title: string; artist: string; duration: number; isrc: string } | null> {
    const cacheKey = `dz_isrc_${isrc}`;
    const cached = await this.cacheService.get<any>(cacheKey);
    if (cached) return cached;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, {
        headers: { 'User-Agent': UA },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const j: any = await res.json();
      if (!j?.id) return null;
      const out = {
        id: String(j.id),
        title: j.title || '',
        artist: j?.artist?.name || '',
        duration: j.duration || 0,
        isrc: j.isrc || isrc,
      };
      await this.cacheService.set(cacheKey, out, 86400);
      return out;
    } catch (err: any) {
      this.logger.warn(`Deezer ISRC lookup failed for ${isrc}: ${err?.message || err}`);
      return null;
    }
  }

  // MusicBrainz allows ~1 req/s per IP; bursty search prefetches otherwise
  // trigger 503s that were silently swallowed (surfacing as "no match" with
  // no log line). Serialize lookups with a minimum spacing between them.
  private mbNextAt = 0;
  private mbChain: Promise<unknown> = Promise.resolve();

  private async mbFetch(url: string, signal: AbortSignal) {
    const run = async () => {
      const wait = Math.max(0, this.mbNextAt - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.mbNextAt = Date.now() + 1100;
      return fetch(url, {
        headers: { 'User-Agent': 'YazhIsai/1.0 (https://yazh-isai.onrender.com)' },
        signal,
      });
    };
    const p = this.mbChain.then(run, run);
    this.mbChain = p.catch(() => undefined);
    return p;
  }

  /**
   * MusicBrainz ISRC lookup by title+artist (no key, ~1 req/s). Returns ALL
   * candidate ISRCs from the top matches — the first one is often a live/
   * compilation recording that Deezer doesn't have, so callers try each.
   */
  private async lookupIsrcFromMusicBrainz(title: string, artist: string): Promise<string[]> {
    const cacheKey = `mb_isrc_${md5(`${title}|${artist}`.toLowerCase()).slice(0, 16)}`;
    const cached = await this.cacheService.get<string | string[]>(cacheKey);
    if (Array.isArray(cached)) return cached;
    if (typeof cached === 'string' && cached) return [cached];
    const clean = (s: string) => (s || '').replace(/["']/g, '').trim();
    const query = `recording:"${clean(title)}"${artist ? ` AND artist:"${clean(artist)}"` : ''}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=10`;
      let res = await this.mbFetch(url, controller.signal);
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await this.mbFetch(url, controller.signal);
      }
      clearTimeout(timer);
      if (!res.ok) {
        this.logger.warn(`MusicBrainz HTTP ${res.status} for "${title}"`);
        return [];
      }
      const j: any = await res.json();
      const recs: any[] = j?.recordings || [];
      const out: string[] = [];
      for (const rec of recs) {
        for (const isrc of rec?.isrcs || []) {
          if (typeof isrc === 'string' && isrc && !out.includes(isrc)) out.push(isrc);
        }
      }
      if (out.length > 0) await this.cacheService.set(cacheKey, out, 86400);
      return out;
    } catch (err: any) {
      this.logger.warn(`MusicBrainz ISRC lookup failed: ${err?.message || err}`);
      return [];
    }
  }

  // -------------------------------------------------------- stream resolve

  /**
   * Resolve a full-length lossless FLAC stream for a title/artist. Returns
   * null when ARL is unset, the track can't be matched, or the account can't
   * stream lossless — callers fall back to Saavn/YouTube.
   * 
   * Now includes fallback to external Deezer service when primary method fails.
   */
  async getBestFlacStream(
    title: string,
    artist: string,
  ): Promise<DeezerFlacDetails | null> {
    // Try primary Deezer method first (requires ARL)
    if (this.isEnabled()) {
      if (!title) return null;

      // Cache the whole resolution. The streamUrl is our STABLE decrypting
      // proxy path (not the expiring CDN url), so it's safe to cache longer.
      const cacheKey = `dz_flac_${md5(`${title}|${artist}`.toLowerCase()).slice(0, 16)}`;
      const cached = await this.cacheService.get<DeezerFlacDetails>(cacheKey);
      if (cached) return cached;

      // Validate the ARL session FIRST — a dead/free-tier ARL can never
      // produce FLAC, so don't burn MusicBrainz quota per track.
      const session = await this.ensureSession();
      if (!session) {
        // Invalid ARL — fall straight through to the external fallback.
      } else if (!session.canLossless) {
        // Account has no lossless entitlement — Deezer lane skipped (logged
        // once by ensureSession), fall through to the external fallback.
      } else {
        // 1. title/artist -> ISRC candidates (MusicBrainz), then ISRC -> Deezer
        // track id. Try each candidate: the first is often a live/comp recording
        // Deezer doesn't carry (800 "no data").
        const isrcCandidates = await this.lookupIsrcFromMusicBrainz(title, artist);
        let track: any = null;
        let isrc: string | undefined;
        for (const candidate of isrcCandidates) {
          track = await this.lookupTrackByIsrc(candidate);
          if (track?.id) {
            isrc = candidate;
            break;
          }
        }
        // Fallback: search Deezer by title/artist directly (public API).
        if (!track) {
          track = await this.searchDeezerTrack(title, artist);
          if (track?.isrc) isrc = track.isrc;
        }
        if (!track?.id) {
          this.logger.log(`Deezer: no match for "${title}" by "${artist}"`);
          // Fall through to external fallback if enabled
        } else {
          const details = await this.resolveByTrackId(track.id, track, isrc ?? undefined);
          if (details) {
            await this.cacheService.set(cacheKey, details, 21600);
            return details;
          }
          // Fall through to external fallback if resolve failed
        }
      }
    }

    // Try external fallback if primary method failed or not configured
    if (this.isFallbackEnabled()) {
      const fallbackResult = await this.resolveViaFallback(title, artist);
      if (fallbackResult) {
        // Cache fallback results for a shorter time (1 hour) since they're less reliable
        const cacheKey = `dz_fallback_${md5(`${title}|${artist}`.toLowerCase()).slice(0, 16)}`;
        await this.cacheService.set(cacheKey, fallbackResult, 3600);
        return fallbackResult;
      }
    }

    return null;
  }

  /** Public Deezer search (no ARL) — fallback when MusicBrainz has no ISRC. */
  private async searchDeezerTrack(title: string, artist: string): Promise<any | null> {
    const q = `${title} ${artist}`.trim();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`,
        { headers: { 'User-Agent': UA }, signal: controller.signal },
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      const j: any = await res.json();
      const items: any[] = j?.data || [];
      if (items.length === 0) return null;
      // Prefer an exact-ish title match.
      const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const want = norm(title);
      const best =
        items.find((it) => norm(it.title).includes(want) || want.includes(norm(it.title))) || items[0];
      return {
        id: String(best.id),
        title: best.title || title,
        artist: best?.artist?.name || artist,
        duration: best.duration || 0,
        isrc: best.isrc || undefined,
      };
    } catch {
      return null;
    }
  }

  /** Given a Deezer track id, get its TRACK_TOKEN and then the FLAC url. */
  private async resolveByTrackId(
    trackId: string,
    trackMeta: any,
    isrc?: string,
  ): Promise<DeezerFlacDetails | null> {
    const session = await this.ensureSession();
    if (!session) return null;

    // 2. song.getListData -> TRACK_TOKEN (+ MD5_ORIGIN / FILESIZE_FLAC).
    // Requires the per-session checkForm api_token; 'null' returns no data.
    const listRes = await this.gwCall<any>(
      'song.getListData',
      { sng_ids: [trackId] },
      session.apiToken,
    );
    const entry: any = listRes?.data?.[0];
    if (!entry) {
      this.logger.warn(`Deezer song.getListData returned no data for ${trackId}`);
      return null;
    }
    // Geoblocked tracks carry a FALLBACK with a resolvable id/token.
    const src = entry.FALLBACK && entry.FALLBACK.TRACK_TOKEN ? entry.FALLBACK : entry;
    const trackToken = src.TRACK_TOKEN;
    if (!trackToken) {
      this.logger.warn(`Deezer: no TRACK_TOKEN for ${trackId}`);
      return null;
    }
    const resolvableId = String(src.SNG_ID || trackId);

    // Confirm lossless is actually available for this account+track. A zero
    // FILESIZE_FLAC means the title is geoblocked/downgraded for the ARL's
    // country — fall through to Saavn/YouTube rather than claim FLAC.
    const fileSize = Number(src.FILESIZE_FLAC || 0);
    if (fileSize <= 0) {
      this.logger.log(`Deezer: no FLAC available for ${resolvableId} (account/region)`);
      return null;
    }

    // The streamUrl is our STABLE decrypting-proxy path (the raw CDN url is
    // Blowfish-encrypted AND expires, so we never hand it to the client).
    // The tracks controller rewrites this to an absolute URL per-request.
    return {
      streamUrl: `/api/v1/deezer/stream/${resolvableId}`,
      trackId: resolvableId,
      proxyUrl: `/api/v1/deezer/stream/${resolvableId}`,
      bitrate: 1411,
      codec: 'FLAC',
      mimeType: 'audio/flac',
      qualityLabel: 'FLAC 16-bit/44.1kHz (Lossless)',
      quality: 'high',
      isLossless: true,
      source: 'Deezer FLAC',
      title: trackMeta?.title || '',
      artists: trackMeta?.artist || '',
      isEncrypted: true,
      fileSize,
      duration: trackMeta?.duration || Number(src.DURATION || 0),
      isrc,
    };
  }

  private async getMediaUrl(licenseToken: string, trackToken: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch('https://media.deezer.com/v1/get_url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Origin: 'https://www.deezer.com',
          Referer: 'https://www.deezer.com/',
        },
        body: JSON.stringify({
          license_token: licenseToken,
          media: [{ type: 'FULL', formats: [{ format: 'FLAC', cipher: 'BF_CBC_STRIPE' }] }],
          track_tokens: [trackToken],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        this.logger.warn(`Deezer get_url HTTP ${res.status}`);
        return null;
      }
      const j: any = await res.json();
      const d = j?.data?.[0];
      if (!d) return null;
      if (d.errors?.length) {
        const code = d.errors[0].code;
        this.logger.warn(`Deezer get_url error ${code}: ${JSON.stringify(d.errors[0])}`);
        return null;
      }
      const sources = d?.media?.[0]?.sources || [];
      // Prefer the "ak" provider (official CDN) when present.
      const ak = sources.find((s: any) => s?.provider === 'ak');
      return (ak || sources[0])?.url || null;
    } catch (err: any) {
      this.logger.warn(`Deezer get_url failed: ${err?.message || err}`);
      return null;
    }
  }

  // ----------------------------------------------------- decrypting proxy

  /**
   * Stream a Deezer FLAC track through our origin, decrypting the
   * BF_CBC_STRIPE stripes on the fly and honoring Range requests.
   *
   * Stripe rule (matches every public Deezer tool): the file is split into
   * 2048-byte chunks; chunks where `index % 3 === 0` are Blowfish-CBC
   * encrypted (fixed IV 00..07, no padding); the other two thirds are
   * plaintext. Because each encrypted stripe decrypts independently, any
   * byte range can be served without buffering the whole file.
   */
  async proxyStream(
    trackId: string,
    rangeHeader: string | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; stream: NodeJS.ReadableStream | null; totalBytes: number }> {
    const session = await this.ensureSession();
    if (!session) return { status: 404, headers: {}, stream: null, totalBytes: 0 };

    // Get a fresh CDN url for this track.
    const listRes = await this.gwCall<any>(
      'song.getListData',
      { sng_ids: [trackId] },
      session.apiToken,
    );
    const entry: any = listRes?.data?.[0];
    if (!entry) return { status: 404, headers: {}, stream: null, totalBytes: 0 };
    const src = entry.FALLBACK && entry.FALLBACK.TRACK_TOKEN ? entry.FALLBACK : entry;
    const trackToken = src.TRACK_TOKEN;
    if (!trackToken) return { status: 404, headers: {}, stream: null, totalBytes: 0 };

    const url = await this.getMediaUrl(session.licenseToken, trackToken);
    if (!url) return { status: 404, headers: {}, stream: null, totalBytes: 0 };

    const isEncrypted = url.includes('/mobile/') || url.includes('/media/');
    const totalBytes = Number(src.FILESIZE_FLAC || 0);

    // Determine the byte range to fetch from Deezer. We must fetch from a
    // 2048-aligned start so stripes decrypt correctly. When the file size is
    // unknown we can't safely slice (stripe alignment would break), so we
    // ignore Range and stream the whole decrypted file.
    const STRIPE = 2048;
    let start = 0;
    let end = totalBytes > 0 ? totalBytes - 1 : Number.MAX_SAFE_INTEGER;
    let hasRange = false;
    if (rangeHeader && totalBytes > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        hasRange = true;
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), totalBytes - 1);
      }
    }
    // Align the upstream fetch down to a stripe boundary.
    const fetchStart = isEncrypted ? Math.floor(start / STRIPE) * STRIPE : start;

    // Fetch the upstream bytes.
    let upstream: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.deezer.com/' };
      // Only pass a Range upstream when the end is known (bounded file).
      if (hasRange && totalBytes > 0) {
        headers.Range = `bytes=${fetchStart}-${end}`;
      }
      upstream = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!upstream.ok && upstream.status !== 206) {
        this.logger.warn(`Deezer proxy upstream ${upstream.status}`);
        return { status: 502, headers: {}, stream: null, totalBytes: 0 };
      }
    } catch (err: any) {
      this.logger.warn(`Deezer proxy fetch failed: ${err?.message || err}`);
      return { status: 502, headers: {}, stream: null, totalBytes: 0 };
    }

     // If not encrypted, just pipe through (preserve upstream status/headers).
     if (!isEncrypted) {
       const outHeaders: Record<string, string> = {
         'Content-Type': upstream.headers.get('content-type') || 'audio/flac',
         'Accept-Ranges': 'bytes',
       };
       const cl = upstream.headers.get('content-length');
       if (cl) outHeaders['Content-Length'] = cl;
       const cr = upstream.headers.get('content-range');
       if (cr) outHeaders['Content-Range'] = cr;
       this.logger.log(`Deezer proxy serving unencrypted FLAC stream, totalBytes: ${totalBytes}`);
       return {
         status: upstream.status,
         headers: outHeaders,
         stream: upstream.body as NodeJS.ReadableStream,
         totalBytes,
       };
     }

    // Encrypted: decrypt stripes on the fly, then slice to the requested range.
    const key = deezerBlowfishKey(trackId, md5);
    const bf = new Blowfish(key);
    const iv = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

    // We buffer decrypted bytes and emit the exact requested slice. For a
    // bounded range this is at most (end-start+1) bytes plus stripe slack.
    const outHeaders: Record<string, string> = {
      'Content-Type': 'audio/flac',
      'Accept-Ranges': 'bytes',
    };
    // Content-Range is only valid on 206 responses. A full-file 200 must not
    // carry it (RFC 7233) — only advertise Content-Length when known.
    if (hasRange && totalBytes > 0) {
      outHeaders['Content-Length'] = String(end - start + 1);
      outHeaders['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`;
    } else if (totalBytes > 0) {
      outHeaders['Content-Length'] = String(totalBytes);
    }

    const { Readable } = await import('stream');
    const upstreamBody: any = upstream.body;

    const out = new Readable({
      read() {
        /* pushed below */
      },
    });

    let stripeIndex = Math.floor(fetchStart / STRIPE);
    // The first stripe we decrypt covers logical bytes starting at fetchStart
    // (the stripe-aligned upstream offset), NOT byte 0 of the file. Range
    // slicing in pushBuf is keyed off this, so it must be exact.
    let outPos = fetchStart;
    let ended = false;

    const pushBuf = (buf: Uint8Array) => {
      if (ended) return;
      // buf covers logical bytes [outPos, outPos+buf.length)
      const bufEnd = outPos + buf.length;
      // Intersection with [start, end]:
      const from = Math.max(outPos, start);
      const to = Math.min(bufEnd, end + 1);
      if (from < to) {
        const slice = buf.slice(from - outPos, to - outPos);
        out.push(Buffer.from(slice));
      }
      outPos = bufEnd;
      if (totalBytes > 0 && outPos > end) {
        ended = true;
        out.push(null);
        upstreamBody.destroy?.();
      }
    };

    let carry: Buffer = Buffer.alloc(0);

    upstreamBody.on('data', (chunk: Buffer) => {
      if (ended) return;
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      // Process full stripes; keep any trailing partial stripe in carry.
      while (carry.length >= STRIPE) {
        const stripe = carry.subarray(0, STRIPE);
        carry = carry.subarray(STRIPE);
        const decrypted = stripeIndex % 3 === 0 ? bf.decryptCbc(stripe, iv) : stripe;
        stripeIndex++;
        pushBuf(decrypted);
        if (ended) break;
      }
    });

    upstreamBody.on('end', () => {
      if (ended) return;
      // Flush any remaining partial stripe (tail of file).
      if (carry.length > 0) {
        const decrypted = stripeIndex % 3 === 0 ? bf.decryptCbc(carry, iv) : carry;
        stripeIndex++;
        pushBuf(decrypted);
      }
      if (!ended) {
        ended = true;
        out.push(null);
      }
    });

    upstreamBody.on('error', (err: Error) => {
      if (!ended) {
        ended = true;
        out.destroy(err);
      }
    });

    return { status: hasRange && totalBytes > 0 ? 206 : 200, headers: outHeaders, stream: out, totalBytes };
  }
}
