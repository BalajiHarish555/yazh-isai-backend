import { Controller, Get, Query, Param, HttpException, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LyricsService } from './lyrics.service';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s || '');
  } catch {
    return s || '';
  }
}

// Each lookup fans out to several upstream lyric APIs.
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('lyrics')
export class LyricsController {
  constructor(private readonly lyricsService: LyricsService) {}

  @Get()
  async getLyrics(
    @Query('artist') artist: string,
    @Query('track') track: string,
    @Query('title') title?: string,
  ) {
    // Accept `title` as an alias — some clients send title instead of track.
    const trackName = (track || title || '').trim();
    const artistName = (artist || '').trim();
    if (!artistName || !trackName) {
      throw new HttpException({ error: 'Both artist and track parameters are required' }, HttpStatus.BAD_REQUEST);
    }

    const result = await this.lyricsService.getLyricsWithSync(artistName, trackName);
    if (result === null) {
      throw new HttpException({ error: 'Lyrics not found' }, HttpStatus.NOT_FOUND);
    }

    return { lyrics: result.lyrics, synced: result.synced };
  }

  @Get('search')
  async searchLyrics(@Query('q') q: string) {
    if (!q) {
      throw new HttpException({ error: 'Search query parameter is required' }, HttpStatus.BAD_REQUEST);
    }

    const results = await this.lyricsService.searchLyricsBySnippet(q);
    if (results === null) {
      throw new HttpException({ error: 'Search failed' }, HttpStatus.BAD_GATEWAY);
    }

    return { results };
  }

  @Get(':artist/:track')
  async getLyricsByPath(
    @Param('artist') artist: string,
    @Param('track') track: string,
  ) {
    const artistName = safeDecode(artist).trim();
    const trackName = safeDecode(track).trim();
    if (!artistName || !trackName) {
      throw new HttpException({ error: 'Both artist and track parameters are required' }, HttpStatus.BAD_REQUEST);
    }
    const result = await this.lyricsService.getLyricsWithSync(artistName, trackName);
    if (result === null) {
      throw new HttpException({ error: 'Lyrics not found' }, HttpStatus.NOT_FOUND);
    }

    return { lyrics: result.lyrics, synced: result.synced };
  }
}