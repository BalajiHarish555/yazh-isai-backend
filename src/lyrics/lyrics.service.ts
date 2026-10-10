import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { LyricsProvider } from './lyrics.provider';
import { LrcLibLyricsProvider } from './providers/lrclib.provider';
import { BetterLyricsLyricsProvider } from './providers/betterlyrics.provider';
import { LyricsOvhLyricsProvider } from './providers/lyricsovh.provider';
import fetch from 'node-fetch';

interface LyricsResponse {
  lyrics: string;
  error?: string;
}

@Injectable()
export class LyricsService {
  private readonly logger = new Logger(LyricsService.name);
  private readonly providers: LyricsProvider[];

  constructor(private cacheService: CacheService) {
    // Initialize providers in order of preference. LrcLib is the primary
    // source (fast, has synced+plain lyrics incl. Tamil catalog). LyricsOvh
    // is second (fast misses). BetterLyrics is last resort — it has been
    // observed to hang, so it is only reached when the first two miss.
    this.providers = [
      new LrcLibLyricsProvider(),
      new LyricsOvhLyricsProvider(),
      new BetterLyricsLyricsProvider(),
    ];
  }

  /**
   * Clean artist and track names by removing extra metadata and formatting
   */
  private cleanArtistName(artist: string): string {
    if (!artist) return '';

    // YouTube subtitles bundle "Artist1, Artist2 & Artist3 • Album" into one
    // string. The "• Album" tail is not an artist — drop it first.
    let cleaned = artist.split('•')[0].trim();

    // Remove extra commas, spaces, and common metadata patterns
    cleaned = cleaned
      // Remove extra commas and spaces
      .replace(/,\s*,/g, ',')          // Replace ", ," with ","
      .replace(/^,|,$/g, '')           // Remove leading/trailing commas
      .replace(/\s+/g, ' ')            // Normalize whitespace
      .trim();

    // Remove common metadata patterns that might interfere with search
    cleaned = cleaned
      // Remove text in parentheses that seems to be metadata
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      // Remove text in brackets that seems to be metadata
      .replace(/\s*\[[^\]]*\]\s*/g, ' ')
      // Remove common suffixes/prefixes that aren't part of artist name
      .replace(/\s*(?:feat\.?|ft\.?|featuring)\s*.*$/i, '')
      .replace(/^\s*(?:the\s+)/i, '') // Remove leading "the"
      .replace(/\s+/g, ' ')             // Normalize whitespace again
      .trim();

    return cleaned || artist; // Return original if cleaning removed everything
  }

  /**
   * Clean track name by removing extra metadata and formatting
   */
  private cleanTrackName(track: string): string {
    if (!track) return '';
    
    // Remove extra commas, spaces, and common metadata patterns
    let cleaned = track
      // Remove extra commas and spaces
      .replace(/,\s*,/g, ',')          // Replace ", ," with ","
      .replace(/^,|,$/g, '')           // Remove leading/trailing commas
      .replace(/\s+/g, ' ')            // Normalize whitespace
      .trim();
    
    // Remove common metadata patterns that might interfere with search
    cleaned = cleaned
      // Remove text in parentheses that seems to be metadata (like duration, source)
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      // Remove text in brackets that seems to be metadata  
      .replace(/\s*\[[^\]]*\]\s*/g, ' ')
      // Remove common suffixes like "(From Movie)", "(Official Video)", etc.
      .replace(/\s*\([^)]*(?:from|official|video|audio|lyric)[^)]*\)\s*/gi, ' ')
      // Remove duration patterns like "(2:35)", "2:35 - "
      .replace(/\s*\(?\d{1,2}:\d{2}\)?\s*-?\s*/g, ' ')
      .replace(/\s*-?\s*\d{1,2}:\d{2}\s*\(?/g, ' ')
      // Remove " - " separators that aren't part of the title
      .replace(/\s+-\s+/g, ' ')
      // Clean up extra spaces
      .replace(/\s+/g, ' ')
      .trim();
    
    return cleaned || track; // Return original if cleaning removed everything
  }

  /**
   * First artist of a bundled string ("A, B & C • Album" -> "A").
   */
  private primaryArtist(artist: string): string {
    return artist.split('•')[0].split(/[,;&|/]/)[0].trim();
  }

  /**
   * Generate alternative search queries when exact match fails.
   * Kept deliberately small (max 3): each variation fans out into provider
   * HTTP calls, and unbounded variations were turning one lyrics request
   * into 10+ upstream requests and multi-second stalls.
   */
  private generateAlternativeQueries(artist: string, track: string): Array<{artist: string; track: string}> {
    const alternatives: Array<{artist: string; track: string}> = [];

    const cleanedArtist = this.cleanArtistName(artist);
    const cleanedTrack = this.cleanTrackName(track);
    const primary = this.primaryArtist(cleanedArtist || artist);

    // 1. Cleaned query (handles "• Album" tails, "(From ...)", etc.)
    if (cleanedArtist && cleanedTrack) {
      alternatives.push({ artist: cleanedArtist, track: cleanedTrack });
    }

    // 2. Primary-artist-only variant for bundled multi-artist subtitles
    if (primary && primary !== cleanedArtist && cleanedTrack) {
      alternatives.push({ artist: primary, track: cleanedTrack });
    }

    // 3. Main track title before " - " separators
    if (cleanedTrack.includes(' - ')) {
      const [mainPart] = cleanedTrack.split(' - ').map(part => part.trim());
      if (mainPart && mainPart !== cleanedTrack) {
        alternatives.push({ artist: primary || cleanedArtist, track: mainPart });
      }
    }

    // Remove duplicates and empties, cap at 3
    const unique = alternatives.filter((item, index, self) =>
      item.artist && item.track &&
      index === self.findIndex(t => t.artist === item.artist && t.track === item.track)
    );

    return unique.slice(0, 3);
  }

  async getLyrics(artist: string, track: string): Promise<string | null> {
    const result = await this.getLyricsWithSync(artist, track);
    return result?.lyrics || null;
  }

  /**
   * Same as getLyrics but also returns raw synced (LRC) lyrics when the
   * winning provider has them — used for the karaoke view.
   */
  async getLyricsWithSync(
    artist: string,
    track: string,
  ): Promise<{ lyrics: string; synced: string | null } | null> {
    if (!artist || !track) {
      this.logger.warn('Lyrics request missing artist or track parameter');
      return null;
    }

    const startTime = Date.now();
    const cacheKey = `lyrics_${artist.toLowerCase().trim()}_${track.toLowerCase().trim()}`;

    // Try to get from cache first (tolerates pre-upgrade plain-string entries)
    const cached = await this.cacheService.get<any>(cacheKey);
    if (cached) {
      this.logger.log(`Cache hit for lyrics: ${artist} - ${track} (took ${Date.now() - startTime}ms)`);
      if (typeof cached === 'string') return { lyrics: cached, synced: null };
      if (cached.lyrics) return { lyrics: cached.lyrics, synced: cached.synced || null };
    }

    this.logger.log(`Fetching lyrics for: "${artist}" - "${track}"`);

    // Try each provider in order until we find lyrics
    for (const provider of this.providers) {
      try {
        // Check if provider is available
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
          this.logger.log(`Provider ${provider.name} reported as unavailable, skipping`);
          continue;
        }

        this.logger.log(`Trying provider: ${provider.name}`);
        const fetchStart = Date.now();

        // Generate alternative queries to try
        const queries = this.generateAlternativeQueries(artist, track);
        let found: { text: string; synced: string | null } | null = null;

        // Slow last-resort providers get exactly one shot (the best query),
        // not one slow call per variation.
        const attempts =
          provider.name === 'BetterLyrics' ? queries.slice(0, 1) : queries;

        // Try each variation until we find lyrics
        for (const { artist: queryArtist, track: queryTrack } of attempts) {
          if (queryArtist && queryTrack) {
            this.logger.log(`  Trying query: "${queryArtist}" - "${queryTrack}"`);
            // LrcLib can return synced lyrics alongside the plain text.
            if (provider.name === 'LrcLib' && 'fetchLyricsWithSync' in provider) {
              found = await (provider as any).fetchLyricsWithSync(queryArtist, queryTrack);
            } else {
              const text = await provider.fetchLyrics(queryArtist, queryTrack);
              found = text ? { text, synced: null } : null;
            }
            if (found) {
              this.logger.log(`    Found lyrics via ${provider.name} with query: "${queryArtist}" - "${queryTrack}"`);
              break;
            }
          }
        }

        this.logger.log(`Provider ${provider.name} took ${Date.now() - fetchStart}ms`);

        if (found) {
          const result = { lyrics: found.text, synced: found.synced };
          // Cache the lyrics for 1 day (86400 seconds)
          await this.cacheService.set(cacheKey, result, 86400);

          this.logger.log(`Lyrics fetched and cached from ${provider.name} for "${artist}" - "${track}" (took ${Date.now() - startTime}ms)`);
          return result;
        }
      } catch (error: any) {
        this.logger.error(`Error fetching lyrics from ${provider.name} for "${artist}" - "${track}":`, error.message);
        // Continue to next provider
      }
    }

    this.logger.log(`No lyrics found from any provider for: "${artist}" - "${track}"`);
    return null;
  }

  async searchLyricsBySnippet(snippet: string): Promise<Array<{artist: string; title: string; snippet: string}> | null> {
    if (!snippet) {
      this.logger.warn('Lyrics search request missing snippet parameter');
      return null;
    }

    const startTime = Date.now();
    const cacheKey = `lyrics_search_${snippet.toLowerCase()}`;
    
    // Try to get from cache first
    const cachedResults = await this.cacheService.get<any[]>(cacheKey);
    if (cachedResults) {
      this.logger.log(`Cache hit for lyrics search: ${snippet} (took ${Date.now() - startTime}ms)`);
      return cachedResults;
    }

    this.logger.log(`Searching lyrics by snippet: "${snippet}"`);

    try {
      // For now, we'll return empty results as none of our providers support snippet search
      // In a real implementation, you might use a different service like Musixmatch or Genius
      this.logger.log(`Lyrics search by snippet not implemented for current providers`);
      
      // Return empty array as placeholder
      const results: Array<{artist: string; title: string; snippet: string}> = [];
      
      // Cache the empty result for 1 hour to prevent repeated requests
      await this.cacheService.set(cacheKey, results, 3600);
      
      this.logger.log(`Lyrics search completed for snippet "${snippet}" (took ${Date.now() - startTime}ms)`);
      return results;
    } catch (error: any) {
      this.logger.error(`Error searching lyrics by snippet "${snippet}":`, error.message);
      return null;
    }
  }
}