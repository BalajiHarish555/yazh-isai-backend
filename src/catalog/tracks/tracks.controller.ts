import { Controller, Get, Post, Body, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
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

  /**
   * Live trending tracks (JioSaavn charts), reshuffled every call.
   * NOTE: declared before ':id' so 'trending' isn't swallowed as an id.
   */
  @Get('trending')
  async getTrending(@Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(24, parseInt(limit || '12', 10) || 12));
    return this.jioSaavnService.getTrendingSongs(n);
  }

  /**
   * Resolve the best available stream for a track.
   * Source priority: JioSaavn 320kbps AAC (when title+artist are supplied
   * and match confidently) → YouTube best audio (~160kbps Opus).
   * Labels are honest: nothing here is lossless/FLAC.
   */
  private async resolveBestStream(
    id: string,
    title?: string,
    artist?: string,
    quality?: string,
  ) {
    // Data-saver mode skips the 320kbps source entirely.
    if (title && artist && quality !== 'saver') {
      try {
        const saavn = await this.jioSaavnService.getBestStream(title, artist);
        if (saavn) return saavn;
      } catch {
        // Fall through to YouTube
      }
    }
    return this.youtubeMusicService.getAudioStreamDetails(id);
  }

  @Get('stream/:id')
  async getStreamUrl(
    @Param('id') id: string,
    @Query('title') title: string,
    @Query('artist') artist: string,
    @Query('quality') quality: string,
    @Res() res: Response,
  ) {
    const details = await this.resolveBestStream(id, title, artist, quality);
    if (!details) {
      return res.status(404).json({ error: 'Audio stream not found for this track' });
    }
    return res.json({
      streamUrl: details.streamUrl,
      bitrate: details.bitrate,
      codec: details.codec,
      mimeType: details.mimeType,
      qualityLabel: details.qualityLabel,
      quality: (details as any).quality || 'high',
      isLossless: false,
      isFlac: false,
      source: (details as any).source || 'YouTube Music',
    });
  }

  /**
   * Proxy the upstream audio bytes (with Range support) so the player can
   * seek and so expiring upstream URLs stay hidden server-side.
   */
  @Get('proxy/:id')
  async proxyAudioStream(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('title') title: string,
    @Query('artist') artist: string,
    @Query('quality') quality: string,
    @Res() res: Response,
  ): Promise<void> {
    const details = await this.resolveBestStream(id, title, artist, quality);
    if (!details) {
      res.status(404).json({ error: 'Audio stream not found for this track' });
      return;
    }
    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }
      const upstream = await fetch(details.streamUrl, { headers });
      if (!upstream.ok && upstream.status !== 206) {
        // Upstream URL may have expired — fall back to a redirect so the
        // player can retry against the fresh URL directly.
        res.redirect(details.streamUrl);
        return;
      }
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type') || details.mimeType;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Cache-Control', 'no-store');
      if (upstream.body) {
        (upstream.body as any).pipe(res);
      } else {
        res.redirect(details.streamUrl);
      }
    } catch {
      res.redirect(details.streamUrl);
    }
  }

  /**
   * Honest demo endpoint: serves the bundled FLAC sample file with correct
   * headers. This is a demo asset — it is NOT the audio of any catalog
   * track. Per-track FLAC routes were removed because YouTube Music does
   * not provide lossless audio to transcode.
   */
  @Get('flac/demo')
  async streamFlacDemo(@Res() res: Response): Promise<void> {
    const filePath = join(process.cwd(), 'public', 'music', 'sample.flac');
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'FLAC demo asset not found' });
      return;
    }
    res.setHeader('Content-Type', 'audio/flac');
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(filePath);
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
