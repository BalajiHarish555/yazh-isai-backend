import { Controller, Get, Post, Body, Param, Query, Res, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TracksService } from './tracks.service';
import { YouTubeMusicService } from '../youtube-music.service';
import { JioSaavnService } from '../jiosaavn.service';

// YouTube video ids are always 11 chars of [A-Za-z0-9_-]. Anything else is
// either garbage or an attempt to make us spawn processes/fetch URLs for
// attacker input (SSRF) and poison caches under attacker-chosen keys.
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SAAVN_ID_RE = /^saavn-[A-Za-z0-9_-]+$/;

function assertVideoId(id: string) {
  if (!VIDEO_ID_RE.test(id || '')) {
    throw new BadRequestException('Invalid track id');
  }
}

function isSaavnId(id: string): boolean {
  return SAAVN_ID_RE.test(id || '');
}

// ---- Artwork optimization (GET /tracks/artwork) -------------------------
// Covers arrive as full-size JPEGs; the client asks for a pixel width and we
// resize + re-encode to WebP here, so phones never download a 1000px file to
// draw a 120px tile. SSRF guard: https + exact/suffix host allowlist, and the
// final URL after redirects is re-checked (node-fetch follows redirects).
const ART_WORK_HOSTS = [
  // Observed live: c.saavncdn.com (JioSaavn covers), yt3.googleusercontent.com
  // (YouTube channel art), images.unsplash.com (home hero). Suffix matches
  // cover CDN edge subdomains (lh3., encrypted-tbn0., i., ...).
  'saavncdn.com',
  'googleusercontent.com',
  'ytimg.com',
  'gstatic.com',
  'images.unsplash.com',
  'i.scdn.co',
  'sndcdn.com',
  'static.toiimg.com',
];
const ART_MAX_BYTES = 12 * 1024 * 1024;
const ART_CACHE_MAX = 160;

function allowedArtUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (!ART_WORK_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return null;
    return u;
  } catch {
    return null;
  }
}

/** Insertion-ordered LRU (Map re-insertion on hit) — artwork is immutable
 *  enough for process-lifetime caching and keeps refreshes instant. */
const artCache = new Map<string, Buffer>();
function artCacheGet(key: string): Buffer | undefined {
  const hit = artCache.get(key);
  if (hit) {
    artCache.delete(key);
    artCache.set(key, hit);
  }
  return hit;
}
function artCacheSet(key: string, value: Buffer) {
  artCache.set(key, value);
  if (artCache.size > ART_CACHE_MAX) {
    const oldest = artCache.keys().next().value;
    if (oldest !== undefined) artCache.delete(oldest);
  }
}

@Controller('tracks')
export class TracksController {
  constructor(
    private readonly tracksService: TracksService,
    private readonly youtubeMusicService: YouTubeMusicService,
    private readonly jioSaavnService: JioSaavnService,
  ) {}

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('search/youtube')
  async searchYouTube(@Query('q') q: string) {
    const query = typeof q === 'string' ? q.slice(0, 100) : '';
    return this.youtubeMusicService.searchTracks(query);
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('artwork')
  async artwork(@Query('url') url: string, @Res() res: Response, @Query('w') w?: string): Promise<void> {
    const target = typeof url === 'string' ? allowedArtUrl(url) : null;
    if (!target) throw new BadRequestException('Invalid artwork url');
    const width = (() => {
      const n = Number(w);
      return Number.isFinite(n) && n > 0 ? Math.min(1600, Math.max(32, Math.round(n))) : 400;
    })();

    const cacheKey = `${target.href}|w=${width}`;
    let buf = artCacheGet(cacheKey);
    if (!buf) {
      const up = await fetch(target.href, {
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          accept: 'image/*,*/*;q=0.8',
        },
      }).catch(() => null);
      if (!up || !up.ok) throw new BadRequestException('Artwork fetch failed');
      // Redirects can leave the allowlist — re-check where we actually landed.
      if (!allowedArtUrl(up.url || target.href)) throw new BadRequestException('Artwork url redirected off-allowlist');

      const raw = Buffer.from(await up.arrayBuffer());
      if (raw.length === 0 || raw.length > ART_MAX_BYTES) throw new BadRequestException('Artwork size out of range');

      let out: Buffer;
      try {
        out = await sharp(raw, { failOn: 'none' })
          .rotate()
          .resize({ width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78, effort: 4 })
          .toBuffer();
      } catch {
        throw new BadRequestException('Not a decodable image');
      }
      buf = out;
      artCacheSet(cacheKey, out);
    }

    res.set({
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': String(buf.length),
    });
    res.end(buf);
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('proxy/:id')
  async proxyAudioStream(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('title') title?: string,
    @Query('artist') artist?: string,
    @Query('quality') quality?: string,
  ): Promise<void> {
    if (isSaavnId(id)) {
      await this.proxySaavnStream(id, req, res, title, artist, quality);
      return;
    }
    assertVideoId(id);
    const fail = (code: number, msg: string) => {
      if (!res.headersSent) {
        res.status(code).send(msg);
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    };
    let streamUrl: string | null = null;
    try {
      // Pass title/artist/quality through so the proxy can also hit the
      // Saavn 320/160 lane instead of always falling back to YouTube.
      streamUrl = await this.youtubeMusicService.getAudioStreamUrl(id, title, artist, quality);
    } catch (err) {
      console.error('Audio proxy resolve error:', err);
    }
    if (!streamUrl) {
      fail(404, 'Stream not found');
      return;
    }

    const controller = new AbortController();
    // Connect/headers timeout only — cleared the moment upstream responds.
    // A whole-lifetime timer here would kill any stream longer than N seconds
    // (the old 15 s budget truncated every song it proxied).
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const range = req.headers.range;
      // Referer must match the upstream host: YouTube needs its own, while
      // Saavn's CDN rejects a youtube.com referer.
      const referer = streamUrl.includes('jiosaavn') || streamUrl.includes('saavncdn')
        ? 'https://www.jiosaavn.com/'
        : 'https://www.youtube.com/';
      const upstream = await fetch(streamUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: referer,
          ...(range ? { Range: range } : {}),
        },
        signal: controller.signal,
      });
      // Headers received — the body can stream for minutes; stop the clock.
      clearTimeout(timer);
      if (!upstream.ok && upstream.status !== 206) {
        console.error(`Audio proxy upstream ${upstream.status} for ${id}`);
        fail(502, 'Upstream audio unavailable');
        return;
      }
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/webm');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const body: any = upstream.body;
      if (!body || typeof body.pipe !== 'function') {
        fail(502, 'Empty upstream response');
        return;
      }
      await new Promise<void>((resolve, reject) => {
        body.on('error', reject);
        res.on('error', reject);
        res.on('close', () => {
          try {
            body.destroy();
          } catch {
            // ignore
          }
          resolve();
        });
        body.pipe(res);
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        fail(504, 'Upstream audio timed out');
        return;
      }
      console.error('Audio proxy error:', err?.message || err);
      fail(502, 'Audio proxy error');
    } finally {
      clearTimeout(timer);
    }
  }

  private async proxySaavnStream(
    id: string,
    req: Request,
    res: Response,
    title?: string,
    artist?: string,
    quality?: string,
  ): Promise<void> {
    const fail = (code: number, msg: string) => {
      if (!res.headersSent) {
        res.status(code).send(msg);
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    };
    const q = quality === 'saver' ? 'saver' : 'best';
    let streamUrl: string | null = null;
    try {
      const details = await this.jioSaavnService.getStreamBySongId(id, q);
      streamUrl = details?.streamUrl || null;
    } catch (err) {
      console.error('Saavn proxy resolve error:', err);
    }
    if (!streamUrl) {
      fail(404, 'Stream not found');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const range = req.headers.range;
      const upstream = await fetch(streamUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.jiosaavn.com/',
          ...(range ? { Range: range } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!upstream.ok && upstream.status !== 206) {
        console.error(`Saavn proxy upstream ${upstream.status} for ${id}`);
        fail(502, 'Upstream audio unavailable');
        return;
      }
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mp4');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const body: any = upstream.body;
      if (!body || typeof body.pipe !== 'function') {
        fail(502, 'Empty upstream response');
        return;
      }
      await new Promise<void>((resolve, reject) => {
        body.on('error', reject);
        res.on('error', reject);
        res.on('close', () => {
          try {
            body.destroy();
          } catch {
            // ignore
          }
          resolve();
        });
        body.pipe(res);
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        fail(504, 'Upstream audio timed out');
        return;
      }
      console.error('Saavn proxy error:', err?.message || err);
      fail(502, 'Saavn proxy error');
    } finally {
      clearTimeout(timer);
    }
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('stream/:id')
  async getStreamUrl(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('title') title?: string,
    @Query('artist') artist?: string,
    @Query('quality') quality?: string,
  ) {
    const host = req.get('host') || 'localhost:5000';
    const forwarded = (req.headers['x-forwarded-proto'] as string) || '';
    const proto = forwarded.split(',')[0].trim() || req.protocol || 'http';
    const proxyParams = new URLSearchParams();
    if (title) proxyParams.set('title', title);
    if (artist) proxyParams.set('artist', artist);
    if (quality) proxyParams.set('quality', quality);
    const qs = proxyParams.toString();
    const proxyUrl = `${proto}://${host}/api/v1/tracks/proxy/${id}${qs ? `?${qs}` : ''}`;

    if (isSaavnId(id)) {
      const q = quality === 'saver' ? 'saver' : 'best';
      // Lossless-by-title lane: saavn catalog ids never reach the YouTube-ID
      // FLAC path, so try Deezer/Tidal FLAC here before settling for AAC.
      // Hard 6s ceiling — a slow match must not delay lossy fallback.
      if (q === 'best' && title && title.length >= 3) {
        const flac = await Promise.race([
          this.youtubeMusicService.resolveLosslessByTitle(title, artist).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
        ]);
        if (flac?.streamUrl) {
          // Deezer/Tidal streams are relative decrypting-proxy paths —
          // absolutize exactly like the YouTube-ID branch does.
          let flacStreamUrl = flac.streamUrl;
          if (typeof flacStreamUrl === 'string' && flacStreamUrl.startsWith('/')) {
            flacStreamUrl = `${proto}://${host}${flacStreamUrl}`;
          }
          return {
            ...flac,
            streamUrl: flacStreamUrl,
            // Keep the Saavn proxy as the client-side fallback hop: if the
            // FLAC stream ever errors, playback degrades to Saavn AAC
            // instead of going silent.
            proxyUrl,
          };
        }
      }
      const details = await this.jioSaavnService.getStreamBySongId(id, q).catch(() => null);
      if (!details) {
        return {
          streamUrl: proxyUrl,
          proxyUrl,
          bitrate: 0,
          codec: 'unknown',
          mimeType: 'audio/webm',
          qualityLabel: 'Unknown',
          quality: 'low',
          isLossless: false,
          source: 'Proxy',
        };
      }
      return {
        ...details,
        streamUrl: details.streamUrl,
        proxyUrl,
      };
    }

    assertVideoId(id);
    const details = await this.youtubeMusicService.getAudioStreamDetails(id, title, artist, quality);
    if (!details) {
      // Resolution failed entirely. Return the proxy URL so the client can
      // still attempt playback, but never fabricate a quality claim we
      // cannot honor (the old code advertised "256kbps High Fidelity" for a
      // URL that would 404).
      return {
        streamUrl: proxyUrl,
        proxyUrl,
        bitrate: 0,
        codec: 'unknown',
        mimeType: 'audio/webm',
        qualityLabel: 'Unknown',
        quality: 'low',
        isLossless: false,
        source: 'Proxy',
      };
    }
    // Primary: direct upstream URL (no server hop). Fallback: same-origin
    // proxy (CORS-safe for the Web Audio EQ graph).
    //
    // The Deezer FLAC lane returns a RELATIVE path (/api/v1/deezer/stream/...)
    // because it must go through our decrypting proxy — the raw CDN url is
    // Blowfish-encrypted AND expiring. Absolutize it against the request host
    // so both the web origin and the APK WebView (different origin) can play it.
    let streamUrl = details.streamUrl;
    if (typeof streamUrl === 'string' && streamUrl.startsWith('/')) {
      streamUrl = `${proto}://${host}${streamUrl}`;
    }
    return {
      ...details,
      streamUrl,
      proxyUrl,
    };
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('autoplay')
  async getAutoplay(
    @Query('title') title: string,
    @Query('artist') artist: string,
    @Query('limit') limit?: string,
    @Query('id') id?: string,
  ) {
    const parsed = Array.isArray(limit) ? NaN : parseInt(limit || '10', 10);
    const n = Number.isFinite(parsed) ? Math.max(1, Math.min(15, Math.floor(parsed))) : 10;
    const norm = (s: string) =>
      (s || '').toLowerCase().replace(/[^a-z0-9\u0B80-\u0BFF ]/gi, '').replace(/\s+/g, ' ').trim();
    const out: any[] = [];
    const seen = new Set<string>();

    const isNonTamil = (text: string) => {
      if (!text) return false;
      if (/[\u0C00-\u0C7F]/.test(text)) return true; // Telugu
      if (/[\u0900-\u097F]/.test(text)) return true; // Hindi
      if (/[\u0D00-\u0D7F]/.test(text)) return true; // Malayalam
      if (/[\u0C80-\u0CFF]/.test(text)) return true; // Kannada

      const lower = text.toLowerCase();
      return (
        lower.includes('telugu') ||
        lower.includes('hindi') ||
        lower.includes('malayalam') ||
        lower.includes('kannada') ||
        lower.includes('tollywood')
      );
    };

    const pushTrack = (t: any) => {
      if (isNonTamil(t.title) || isNonTamil(t.artists) || isNonTamil(t.thumbnail)) return;
      const key = norm(t.title);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    };

    // Primary: YouTube Music's own Up Next queue for this video — the same
    // suggestions the official app would show.
    if (typeof id === 'string' && id) {
      try {
        const upNext = await this.youtubeMusicService.getYouTubeUpNext(id, n);
        for (const t of upNext || []) pushTrack(t);
      } catch {
        // Fall through to Saavn seeds.
      }
    }

    try {
      const seeds = await this.jioSaavnService.getAutoplaySeeds(title || '', artist || '', n * 2);
      for (const s of seeds) {
        // Thumbnail CDN URLs embed the album slug (e.g. "...-Tollywood-Superhits-Telugu-..."),
        // which catches language-neutral titles the text check alone misses.
        pushTrack(s);
      }
    } catch {
      // Fall through
    }

    if (out.length < n && artist) {
      try {
        const cleanArtist = artist.split(',')[0].split('&')[0].trim();
        const yt = await this.youtubeMusicService.searchTracks(`${cleanArtist} tamil hit songs`);
        for (const t of yt || []) {
          if (isNonTamil(t.title) || isNonTamil(t.artists) || isNonTamil(t.thumbnail)) continue;
          const key = norm(t.title);
          if (key && !seen.has(key)) {
            seen.add(key);
            if (!t.reason) t.reason = `More by ${cleanArtist}`;
            out.push(t);
          }
        }
      } catch {
        // ignore
      }
    }

    return out.slice(0, n);
  }

  // Chart feed for the Discover page. Declared before ':id' so 'trending'
  // isn't swallowed as an id.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('trending')
  async getTrending(
    @Query('limit') limit?: string,
    @Query('lang') lang?: string,
    @Query('stable') stable?: string,
  ) {
    const parsed = Array.isArray(limit) ? NaN : parseInt(limit || '30', 10);
    const n = Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 30;
    return this.jioSaavnService.getTrendingSongs(n, {
      lang: typeof lang === 'string' ? lang.slice(0, 20) : undefined,
      stable: stable === '1' || stable === 'true',
    });
  }

  @Get()
  async findAll(
    @Query('mood') mood: string,
    @Query('energyMin') energyMin: string,
    @Query('energyMax') energyMax: string,
  ) {
    return this.tracksService.findAll({
      mood,
      energyMin: energyMin ? parseFloat(energyMin) : undefined,
      energyMax: energyMax ? parseFloat(energyMax) : undefined,
    });
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.tracksService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() dto: any) {
    return this.tracksService.create(dto);
  }
}
