import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { BaseLyricsProvider } from '../lyrics.provider.base';

interface LrcLibTrack {
  syncedLyrics?: string;
  plainLyrics?: string;
  lyrics?: string;
  [key: string]: any;
}

interface LrcLibResponse extends Array<LrcLibTrack> {}

@Injectable()
export class LrcLibLyricsProvider extends BaseLyricsProvider {
  private readonly logger = new Logger(LrcLibLyricsProvider.name);
  protected readonly providerName = 'LrcLib';
  
  private readonly LRC_LIB_API = 'https://lrclib.net/api';

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.LRC_LIB_API}/search?track_name=test&artist_name=test`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'yzh-backend-pro/1.0' },
      });
      clearTimeout(timeoutId);

      // 429/503 = rate-limited/overloaded, not dead. Only treat 5xx (except
      // 429/503) as potentially-down; everything else means reachable.
      if (response.status === 429 || response.status === 503) return true;
      return response.status < 500;
    } catch (error: any) {
      this.logger.log(`LrcLib availability check failed, will still attempt to fetch:`, error.message);
      return true;
    }
  }

  /**
   * Strip LRC timestamps ("[00:12.34] line") so synced-only results still
   * display as clean readable text.
   */
  private stripTimestamps(synced: string): string {
    return synced
      .split('\n')
      .map((line) => line.replace(/^\s*(\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+\s*/, '').trimEnd())
      .filter((line) => line.length > 0 && !/^\[\w+:.+\]$/.test(line))
      .join('\n')
      .trim();
  }

  private scoreMatch(item: LrcLibTrack, artist: string, track: string): number {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9\u0B80-\u0BFF ]/gi, '').trim();
    const wantArtist = norm(artist);
    const wantTrack = norm(track);
    const gotArtist = norm(item.artistName || '');
    const gotTrack = norm(item.trackName || item.name || '');
    let score = 0;
    if (gotTrack && wantTrack) {
      if (gotTrack === wantTrack) score += 3;
      else if (gotTrack.includes(wantTrack) || wantTrack.includes(gotTrack)) score += 2;
    }
    if (gotArtist && wantArtist) {
      if (gotArtist === wantArtist) score += 3;
      else if (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)) score += 2;
    }
    if (item.instrumental) score -= 5;
    if (!item.plainLyrics && !item.syncedLyrics && !item.lyrics) score -= 5;
    return score;
  }

  private async searchOnce(url: string, timeoutMs = 6000): Promise<LrcLibResponse | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'yzh-backend-pro/1.0' },
      });
      if (response.status === 429 || response.status === 503) {
        // Rate-limited / overloaded: honour Retry-After and retry once.
        const retryAfter = Number(response.headers.get('retry-after') || '2');
        const waitMs = Math.min(Math.max(isNaN(retryAfter) ? 2 : retryAfter, 1), 5) * 1000;
        this.logger.log(`LrcLib busy (${response.status}), retrying once after ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), timeoutMs);
        try {
          const retry = await fetch(url, {
            signal: retryController.signal,
            headers: { 'User-Agent': 'yzh-backend-pro/1.0' },
          });
          if (!retry.ok) return null;
          return (await retry.json()) as LrcLibResponse;
        } finally {
          clearTimeout(retryTimeout);
        }
      }
      if (!response.ok) return null;
      return (await response.json()) as LrcLibResponse;
    } catch (error: any) {
      this.logger.log(`LrcLib search failed: ${error?.message || error}`);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchLyrics(artist: string, track: string): Promise<string | null> {
    const result = await this.fetchLyricsWithSync(artist, track);
    return result?.text || null;
  }

  /**
   * Same best-match search as fetchLyrics, but also returns the raw synced
   * (LRC) lyrics when the matched track has them — used for karaoke view.
   */
  async fetchLyricsWithSync(
    artist: string,
    track: string,
  ): Promise<{ text: string; synced: string | null } | null> {
    try {
      // Take primary artist (before comma, &, • or ;) — YouTube subtitles
      // often bundle "Artist1, Artist2 & Artist3 • Album".
      const primaryArtist = artist.split(/[,;&•|]/)[0].trim();
      // Clean track title (remove "(From ...)", "[...]", "(feat. ...)" tags)
      const cleanTrack = track
        .replace(/\s*\(From.*?\)/gi, '')
        .replace(/\s*\[.*?\]/g, '')
        .replace(/\s*\(feat\..*?\)/gi, '')
        .trim();

      // Bounded query plan (max 3): exact combo, primary-artist combo,
      // track-only fallback.
      const queries: Array<{ artist: string; track: string }> = [];
      if (primaryArtist && cleanTrack) {
        queries.push({ artist: primaryArtist, track: cleanTrack });
      }
      if (cleanTrack && cleanTrack !== track) {
        queries.push({ artist: primaryArtist, track });
      }
      if (cleanTrack) {
        queries.push({ artist: '', track: cleanTrack });
      }

      let best: { text: string; synced: string | null } | null = null;
      let bestScore = -Infinity;

      for (const q of queries.slice(0, 3)) {
        let url = `${this.LRC_LIB_API}/search?q=${encodeURIComponent(q.track + (q.artist ? ' ' + q.artist : ''))}`;
        if (q.artist) {
          url = `${this.LRC_LIB_API}/search?track_name=${encodeURIComponent(q.track)}&artist_name=${encodeURIComponent(q.artist)}`;
        }

        const data = await this.searchOnce(url);
        if (Array.isArray(data) && data.length > 0) {
          // Score candidates and pick the best match instead of the first
          // result that happens to contain lyrics.
          const ranked = data
            .map((item) => ({ item, score: this.scoreMatch(item, q.artist || artist, q.track) }))
            .sort((a, b) => b.score - a.score);

          for (const { item, score } of ranked.slice(0, 3)) {
            // Prefer plain lyrics; fall back to synced with timestamps stripped.
            const text =
              item.plainLyrics || item.lyrics || (item.syncedLyrics ? this.stripTimestamps(item.syncedLyrics) : null);
            if (text && score > bestScore) {
              bestScore = score;
              best = { text, synced: item.syncedLyrics || null };
              if (score >= 5) {
                this.logger.log(`Lyrics found on LrcLib for: ${q.artist} - ${q.track} (score ${score})`);
                return best;
              }
            }
          }
          if (best && bestScore >= 2) {
            this.logger.log(`Lyrics found on LrcLib for: ${q.artist} - ${q.track} (score ${bestScore})`);
            return best;
          }
        }
      }

      if (best) {
        this.logger.log(`Lyrics found on LrcLib (weak match, score ${bestScore}) for: ${artist} - ${track}`);
        return best;
      }

      this.logger.log(`No lyrics found on LrcLib for: ${artist} - ${track}`);
      return null;
    } catch (error: any) {
      this.logger.error(`Error fetching lyrics from LrcLib for ${artist} - ${track}:`, error);
      return null;
    }
  }
}
