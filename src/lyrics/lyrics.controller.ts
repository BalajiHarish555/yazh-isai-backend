import { Controller, Get, Query, Param } from '@nestjs/common';
import { LyricsService } from './lyrics.service';

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
      return { error: 'Both artist and track parameters are required' };
    }

    const result = await this.lyricsService.getLyricsWithSync(artistName, trackName);
    if (result === null) {
      return { error: 'Lyrics not found' };
    }

    return { lyrics: result.lyrics, synced: result.synced };
  }

  @Get('search')
  async searchLyrics(@Query('q') q: string) {
    if (!q) {
      return { error: 'Search query parameter is required' };
    }
    
    const results = await this.lyricsService.searchLyricsBySnippet(q);
    if (results === null) {
      return { error: 'Search failed' };
    }
    
    return { results };
  }

  @Get(':artist/:track')
  async getLyricsByPath(
    @Param('artist') artist: string,
    @Param('track') track: string,
  ) {
    const artistName = decodeURIComponent(artist || '').trim();
    const trackName = decodeURIComponent(track || '').trim();
    if (!artistName || !trackName) {
      return { error: 'Both artist and track parameters are required' };
    }
    const result = await this.lyricsService.getLyricsWithSync(artistName, trackName);
    if (result === null) {
      return { error: 'Lyrics not found' };
    }

    return { lyrics: result.lyrics, synced: result.synced };
  }
}