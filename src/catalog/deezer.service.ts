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
  private session: { licenseToken: string; canLossless: boolean; country: string; at: number } | null = null;

  constructor(private cacheService: CacheService) {}

  /** The ARL account cookie. Read from env so no secret is ever committed. */
  private getArl(): string {
    return (process.env.DEEZER_ARL || '').trim();
  }

  /** Whether FLAC playback is configured at all. */
  isEnabled(): boolean {
    return this.getArl().length > 0;
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
      if (json?.error) {
        this.logger.warn(`Deezer gw ${method} error: ${JSON.stringify(json.error)}`);
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
    const results = await this.gwCall<any>('deezer.getUserData', {});
    if (!results) return null;
    const opts = results?.USER?.OPTIONS || {};
    const licenseToken = opts.license_token;
    if (!licenseToken) {
      this.logger.warn('Deezer getUserData returned no license_token (bad ARL?)');
      return null;
    }
    this.session = {
      licenseToken,
      canLossless: !!(opts.web_lossless || opts.mobile_loseless),
      country: results?.COUNTRY || 'XX',
      at: Date.now(),
    };
    this.logger.log(
      `Deezer session ready (lossless=${this.session.canLossless}, country=${this.session.country})`,
    );
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

  /** MusicBrainz ISRC lookup by title+artist (no key, ~1 req/s). */
  private async lookupIsrcFromMusicBrainz(title: string, artist: string): Promise<string | null> {
    const cacheKey = `mb_isrc_${md5(`${title}|${artist}`.toLowerCase()).slice(0, 16)}`;
    const cached = await this.cacheService.get<string>(cacheKey);
    if (cached) return cached;
    const clean = (s: string) => (s || '').replace(/["']/g, '').trim();
    const query = `recording:"${clean(title)}"${artist ? ` AND artist:"${clean(artist)}"` : ''}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
        {
          headers: { 'User-Agent': 'YazhIsai/1.0 (https://yazh-isai.onrender.com)' },
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      const j: any = await res.json();
      const recs: any[] = j?.recordings || [];
      for (const rec of recs) {
        const isrcs: string[] = rec?.isrcs || [];
        if (isrcs.length > 0) {
          const isrc = isrcs[0];
          await this.cacheService.set(cacheKey, isrc, 86400);
          return isrc;
        }
      }
      return null;
    } catch (err: any) {
      this.logger.warn(`MusicBrainz ISRC lookup failed: ${err?.message || err}`);
      return null;
    }
  }

  // -------------------------------------------------------- stream resolve

  /**
   * Resolve a full-length lossless FLAC stream for a title/artist. Returns
   * null when ARL is unset, the track can't be matched, or the account can't
   * stream lossless — callers fall back to Saavn/YouTube.
   */
  async getBestFlacStream(
    title: string,
    artist: string,
  ): Promise<DeezerFlacDetails | null> {
    if (!this.isEnabled()) return null;
    if (!title) return null;

    // Cache the whole resolution. The streamUrl is our STABLE decrypting
    // proxy path (not the expiring CDN url), so it's safe to cache longer.
    const cacheKey = `dz_flac_${md5(`${title}|${artist}`.toLowerCase()).slice(0, 16)}`;
    const cached = await this.cacheService.get<DeezerFlacDetails>(cacheKey);
    if (cached) return cached;

    // 1. title/artist -> ISRC (MusicBrainz), then ISRC -> Deezer track id.
    let isrc = await this.lookupIsrcFromMusicBrainz(title, artist);
    let track: any = null;
    if (isrc) {
      track = await this.lookupTrackByIsrc(isrc);
    }
    // Fallback: search Deezer by title/artist directly (public API).
    if (!track) {
      track = await this.searchDeezerTrack(title, artist);
      if (track?.isrc) isrc = track.isrc;
    }
    if (!track?.id) {
      this.logger.log(`Deezer: no match for "${title}" by "${artist}"`);
      return null;
    }

    const details = await this.resolveByTrackId(track.id, track, isrc ?? undefined);
    if (details) {
      await this.cacheService.set(cacheKey, details, 21600);
    }
    return details;
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
    const listRes = await this.gwCall<any>('song.getListData', { sng_ids: [trackId] });
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
    const listRes = await this.gwCall<any>('song.getListData', { sng_ids: [trackId] });
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
    if (totalBytes > 0) {
      outHeaders['Content-Length'] = String(end - start + 1);
      outHeaders['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`;
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
