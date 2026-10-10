import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { BaseLyricsProvider } from '../lyrics.provider.base';

interface LyricsOvhResponse {
  lyrics?: string;
  error?: string;
  [key: string]: any;
}

@Injectable()
export class LyricsOvhLyricsProvider extends BaseLyricsProvider {
  private readonly logger = new Logger(LyricsOvhLyricsProvider.name);
  protected readonly providerName = 'LyricsOvh';
  
  private readonly LYRICS_OVH_API = 'https://api.lyrics.ovh/v1';

  async isAvailable(): Promise<boolean> {
    // NOTE: https://api.lyrics.ovh/v1/ has no index route (GET /v1/ returns
    // 404 "Cannot GET /v1/"), so probing the root always looked "down" and
    // this fallback was silently skipped for every song. LyricsOvh misses are
    // fast (immediate 404 JSON), so be optimistic here and let fetchLyrics
    // decide per song.
    return true;
  }

  /**
   * Split bundled artist strings ("A, B & C • Album", "A feat. B") into
   * individual candidates so multi-artist YouTube subtitles still hit.
   */
  private artistCandidates(artist: string): string[] {
    const withoutAlbum = artist.split('•')[0];
    const parts = withoutAlbum
      .split(/[,;&|/]+/)
      .flatMap((p) => p.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i))
      .map((p) => p.trim())
      .filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.slice(0, 3);
  }

  async fetchLyrics(artist: string, track: string): Promise<string | null> {
    const candidates = this.artistCandidates(artist);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const url = `${this.LYRICS_OVH_API}/${encodeURIComponent(candidate)}/${encodeURIComponent(track)}`;
      this.logger.log(`Requesting lyrics from LyricsOvh: ${url}`);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        this.logger.log(`LyricsOvh response status: ${response.status}`);
      
        if (!response.ok) {
          if (response.status === 404) {
            this.logger.log(`Lyrics not found on LyricsOvh for: ${candidate} - ${track}, trying next artist`);
            continue;
          }
          const errorText = await response.text();
          this.logger.error(`LyricsOvh API error: ${response.statusText} - ${errorText.substring(0, 200)}`);
          continue;
        }

        const data = await response.json() as LyricsOvhResponse;

        // The LyricsOvh API returns an object with a lyrics property
        if (data && data.lyrics) {
          this.logger.log(`Lyrics found on LyricsOvh for: ${candidate} - ${track} (length: ${data.lyrics.length})`);
          return data.lyrics;
        }

        this.logger.log(`No lyrics found in LyricsOvh response for: ${candidate} - ${track}`);
      } catch (error: any) {
        this.logger.error(`Error fetching lyrics from LyricsOvh for ${candidate} - ${track}:`, error?.message || error);
        continue;
      }
    }

    this.logger.log(`No lyrics found on LyricsOvh for: ${artist} - ${track}`);
    return null;
  }
}