import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { BaseLyricsProvider } from '../lyrics.provider.base';

interface BetterLyricsResponse {
  lyrics?: string;
  [key: string]: any;
}

@Injectable()
export class BetterLyricsLyricsProvider extends BaseLyricsProvider {
  private readonly logger = new Logger(BetterLyricsLyricsProvider.name);
  protected readonly providerName = 'BetterLyrics';
  
  private readonly BETTER_LYRICS_API = 'https://betterlyrics.com/api';

  async isAvailable(): Promise<boolean> {
    // This API has been observed to hang (requests time out). Probe quickly
    // and skip it when unreachable so one dead provider can't stall every
    // lyrics request for 5s x N query variations.
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.BETTER_LYRICS_API}/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      return response.ok;
    } catch (error: any) {
      this.logger.log(`BetterLyrics unavailable, skipping:`, error?.message || error);
      return false;
    }
  }

   async fetchLyrics(artist: string, track: string): Promise<string | null> {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000); // Short: last-resort provider only
       
       const response = await fetch(
         `${this.BETTER_LYRICS_API}/search?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(track)}`,
         { signal: controller.signal }
       );
       clearTimeout(timeoutId);
       
       if (!response.ok) {
         if (response.status === 404) {
           this.logger.log(`No lyrics found on BetterLyrics for: ${artist} - ${track}`);
           return null;
         }
         const errorText = await response.text();
         this.logger.error(`BetterLyrics API error: ${response.status} - ${errorText.substring(0, 200)}`);
         throw new Error(`BetterLyrics API error: ${response.status}`);
       }
 
       const data = await response.json() as BetterLyricsResponse;
       
       // Assuming BetterLyrics returns lyrics in a specific format
       if (data && data.lyrics) {
         this.logger.log(`Lyrics found on BetterLyrics for: ${artist} - ${track}`);
         return data.lyrics;
       }
       
       this.logger.log(`No lyrics found in BetterLyrics response for: ${artist} - ${track}`);
       return null;
     } catch (error: any) {
       this.logger.error(`Error fetching lyrics from BetterLyrics for ${artist} - ${track}:`, error);
       return null;
     }
   }
}