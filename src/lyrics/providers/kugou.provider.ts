import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { BaseLyricsProvider } from '../lyrics.provider.base';

interface KuGouSongInfo {
  hash?: string;
  duration?: number;
  [key: string]: any;
}

interface KuGouCandidate {
  id?: number | string;
  accesskey?: string;
  duration?: number;
  [key: string]: any;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * KuGou lyrics, mirroring Echo Music's flow: song search → lyrics search by
 * hash (keyword fallback) → Base64 LRC download. Synced-only source, no
 * auth, no keys. Especially strong for Asian catalogs.
 */
@Injectable()
export class KuGouLyricsProvider extends BaseLyricsProvider {
  private readonly logger = new Logger(KuGouLyricsProvider.name);
  protected readonly providerName = 'KuGou';

  async isAvailable(): Promise<boolean> {
    // Cheap probe is a full search; misses are fast, so stay optimistic and
    // let fetchLyrics decide per song (same policy as LyricsOvh).
    return true;
  }

  private async getJson(url: string, timeoutMs = 6000): Promise<any | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error: any) {
      this.logger.log(`KuGou request failed: ${error?.message || error}`);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildKeyword(track: string, artist: string): string {
    const cleanTrack = (track || '')
      .replace(/\s*[\(（\[「『<《〈][^\)）\]」』>》〉]*[\)）\]」』>》〉]?\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const primary = (artist || '')
      .split('•')[0]
      .split(/[,;&|/]+/)[0]
      .trim();
    return primary ? `${cleanTrack} - ${primary}` : cleanTrack;
  }

  private async searchSongs(keyword: string): Promise<KuGouSongInfo[]> {
    const data = await this.getJson(
      `https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=8&showtype=0&keyword=${encodeURIComponent(keyword)}`,
    );
    const info = data?.data?.info;
    return Array.isArray(info) ? info : [];
  }

  private async searchLyrics(params: string): Promise<KuGouCandidate[]> {
    const data = await this.getJson(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&${params}`);
    const candidates = data?.candidates;
    return Array.isArray(candidates) ? candidates : [];
  }

  private async downloadLyrics(id: number | string, accesskey: string): Promise<string | null> {
    const data = await this.getJson(
      `https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=${id}&accesskey=${encodeURIComponent(accesskey)}`,
    );
    const content: string = data?.content || '';
    if (!content) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(content, 'base64').toString('utf8');
    } catch {
      return null;
    }
    // Keep timed LRC lines with actual text; drop headers/footers/empties.
    const lines = decoded
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(l))
      .map((l) => l.replace(/^\s*(\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+\s*/, '').trim())
      .filter((l) => l.length > 0 && !/^\[[^\]]+\]$/.test(l));
    if (lines.length < 3) return null;
    // Rebuild LRC with original timestamps for karaoke use.
    const timed = decoded
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(l));
    return timed.length >= 3 ? timed.join('\n') : null;
  }

  private stripTimestamps(synced: string): string {
    return synced
      .split('\n')
      .map((line) => line.replace(/^\s*(\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+\s*/, '').trimEnd())
      .filter((line) => line.length > 0 && !/^\[\w+:.+\]$/.test(line))
      .join('\n')
      .trim();
  }

  async fetchLyricsWithSync(
    artist: string,
    track: string,
  ): Promise<{ text: string; synced: string | null } | null> {
    const keyword = this.buildKeyword(track, artist);
    if (!keyword) return null;

    // 1. Song search → lyrics-by-hash for the top hits (most precise).
    const infos = await this.searchSongs(keyword);
    for (const info of infos.slice(0, 2)) {
      if (!info?.hash) continue;
      const candidates = await this.searchLyrics(`hash=${encodeURIComponent(info.hash)}`);
      for (const cand of candidates.slice(0, 2)) {
        if (cand?.id === undefined || !cand?.accesskey) continue;
        const synced = await this.downloadLyrics(cand.id, cand.accesskey);
        if (synced) {
          this.logger.log(`Lyrics found on KuGou (hash) for: ${artist} - ${track}`);
          return { text: this.stripTimestamps(synced), synced };
        }
      }
    }

    // 2. Keyword lyrics search fallback.
    const candidates = await this.searchLyrics(`keyword=${encodeURIComponent(keyword)}`);
    for (const cand of candidates.slice(0, 2)) {
      if (cand?.id === undefined || !cand?.accesskey) continue;
      const synced = await this.downloadLyrics(cand.id, cand.accesskey);
      if (synced) {
        this.logger.log(`Lyrics found on KuGou (keyword) for: ${artist} - ${track}`);
        return { text: this.stripTimestamps(synced), synced };
      }
    }

    this.logger.log(`No lyrics found on KuGou for: ${artist} - ${track}`);
    return null;
  }

  async fetchLyrics(artist: string, track: string): Promise<string | null> {
    const result = await this.fetchLyricsWithSync(artist, track);
    return result?.text || null;
  }
}
