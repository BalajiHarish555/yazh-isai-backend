import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { CacheService } from '../../common/cache.service';
import { YouTubeMusicService } from '../youtube-music.service';

// Echo Music (Android) addon protocol — see ExtensionManager.kt:
//   GET {addon}/search?q=...            -> {tracks:[{id,title,artist,...}]}
//   GET {addon}/stream/<id>?quality=.. -> {url,format,quality,...} (or non-2xx)
//   GET {addon}/stream?id=..            -> legacy query form of the above.
// Echo treats a stream as lossless iff `format` contains "flac"
// (MusicService.kt), so this shim ONLY serves lossless hits and answers
// 404 otherwise — Echo then falls back to its own YouTube path instead of
// playing a mislabeled lossy stream.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

@Controller('echo')
export class EchoAddonController {
  constructor(
    private readonly youtubeMusicService: YouTubeMusicService,
    private readonly cacheService: CacheService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('search')
  async search(@Query('q') q: string) {
    const query = (q || '').trim();
    if (!query) return { tracks: [] };
    const results =
      (await this.youtubeMusicService.searchTracks(query).catch(() => [])) || [];
    return {
      tracks: results.slice(0, 20).map((t: any) => ({
        id: t?.id || '',
        title: t?.title || '',
        artist: t?.artists || '',
        duration: typeof t?.duration === 'number' ? t.duration : null,
        artworkURL: t?.thumbnail || '',
        albumArtworkURL: t?.thumbnail || '',
      })),
    };
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('stream/:id')
  async streamByPath(
    @Param('id') id: string,
    @Query('quality') quality: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.serveLossless(id, quality, req, res);
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('stream')
  async streamByQuery(
    @Query('id') id: string,
    @Query('quality') quality: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.serveLossless(id, quality, req, res);
  }

  private async serveLossless(
    id: string,
    quality: string | undefined,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!VIDEO_ID_RE.test(id || '')) {
      res.status(400).send('Invalid id');
      return;
    }
    // Echo sends only the id — recover title/artist via oEmbed (no key).
    const meta = await this.resolveMeta(id);
    if (!meta) {
      res.status(404).end();
      return;
    }
    const details = await this.youtubeMusicService
      .getAudioStreamDetails(id, meta.title, meta.artist, quality)
      .catch(() => null);
    if (!details?.isLossless || !details.streamUrl) {
      // Not lossless: 404 so Echo falls back to its own YouTube playback.
      res.status(404).end();
      return;
    }
    let url = details.streamUrl;
    if (url.startsWith('/')) {
      const host = req.get('host') || 'localhost:5000';
      const forwarded = (req.headers['x-forwarded-proto'] as string) || '';
      const proto = forwarded.split(',')[0].trim() || req.protocol || 'http';
      url = `${proto}://${host}${url}`;
    }
    res.json({
      url,
      // Must contain "flac" — Echo's lossless trigger (MusicService.kt).
      format: details.qualityLabel,
      quality: 'LOSSLESS',
      streamQuality: details.qualityLabel,
      audioQuality: 'AUDIO_QUALITY_LOSSLESS',
      codec: details.codec,
    });
  }

  /** Title/artist for a YouTube id via oEmbed (no key), cached 7 days. */
  private async resolveMeta(id: string): Promise<{ title: string; artist: string } | null> {
    const key = `yt_meta_${id}`;
    const cached = await this.cacheService.get<{ title: string; artist: string }>(key);
    if (cached?.title) return cached;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (!r.ok) return null;
      const j: any = await r.json();
      const title = (j?.title || '').trim();
      const artist = (j?.author_name || '').replace(/ - Topic$/, '').trim();
      if (!title) return null;
      const out = { title, artist };
      await this.cacheService.set(key, out, 604800);
      return out;
    } catch {
      return null;
    }
  }
}
