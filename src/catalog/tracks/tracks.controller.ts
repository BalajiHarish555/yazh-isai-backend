import { Controller, Get, Post, Body, Param, Query, Res, Req } from '@nestjs/common';
import { Response, Request } from 'express';
import fetch from 'node-fetch';
import { TracksService } from './tracks.service';
import { YouTubeMusicService } from '../youtube-music.service';
import { JioSaavnService } from '../jiosaavn.service';

@Controller('tracks')
export class TracksController {
  constructor(
    private readonly tracksService: TracksService,
    private readonly youtubeMusicService: YouTubeMusicService,
    private readonly jioSaavnService: JioSaavnService,
  ) {}

  @Get('search/youtube')
  async searchYouTube(@Query('q') q: string) {
    return this.youtubeMusicService.searchTracks(q || '');
  }

  @Get('proxy/:id')
  async proxyAudioStream(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
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
      streamUrl = await this.youtubeMusicService.getAudioStreamUrl(id);
    } catch (err) {
      console.error('Audio proxy resolve error:', err);
    }
    if (!streamUrl) {
      fail(404, 'Stream not found');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const range = req.headers.range;
      const upstream = await fetch(streamUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.youtube.com/',
          ...(range ? { Range: range } : {}),
        },
        signal: controller.signal,
      });
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

  @Get('stream/:id')
  async getStreamUrl(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('title') title?: string,
    @Query('artist') artist?: string,
    @Query('quality') quality?: string,
  ) {
    const details = await this.youtubeMusicService.getAudioStreamDetails(id, title, artist, quality);
    // Build the fallback proxy URL from the request host — never hardcode
    // localhost, or LAN/cloud clients receive an unroutable URL.
    const host = req.get('host') || 'localhost:5000';
    const forwarded = (req.headers['x-forwarded-proto'] as string) || '';
    const proto = forwarded.split(',')[0].trim() || req.protocol || 'http';
    const proxyUrl = `${proto}://${host}/api/v1/tracks/proxy/${id}`;
    if (!details) {
      return {
        streamUrl: proxyUrl,
        proxyUrl,
        bitrate: 256,
        codec: 'Opus 256kbps',
        mimeType: 'audio/webm',
        qualityLabel: '256kbps High Fidelity (Opus)',
      };
    }
    // Primary: direct upstream URL (no server hop). Fallback: same-origin
    // proxy (CORS-safe for the Web Audio EQ graph).
    return {
      ...details,
      proxyUrl,
    };
  }

  @Get('autoplay')
  async getAutoplay(
    @Query('title') title: string,
    @Query('artist') artist: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.max(1, Math.min(15, parseInt(limit || '10', 10) || 10));
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

    try {
      const seeds = await this.jioSaavnService.getAutoplaySeeds(title || '', artist || '', n * 2);
      for (const s of seeds) {
        // Thumbnail CDN URLs embed the album slug (e.g. "...-Tollywood-Superhits-Telugu-..."),
        // which catches language-neutral titles the text check alone misses.
        if (isNonTamil(s.title) || isNonTamil(s.artists) || isNonTamil(s.thumbnail)) continue;
        const key = norm(s.title);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(s);
        }
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
            out.push(t);
          }
        }
      } catch {
        // ignore
      }
    }

    return out.slice(0, n);
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

  @Post()
  async create(@Body() dto: any) {
    return this.tracksService.create(dto);
  }
}
