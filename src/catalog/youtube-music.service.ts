import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import youtubedl from 'youtube-dl-exec';
import ytdl from '@distube/ytdl-core';
import fetch from 'node-fetch';
import { CacheService } from '../common/cache.service';
import { JioSaavnService } from './jiosaavn.service';

// Queries users type first, warmed shortly after boot so opening searches
// feel instant instead of paying a cold upstream round-trip.
const WARM_QUERIES = [
  'tamil hits',
  'anirudh ravichander tamil song',
  'a r rahman tamil song',
  'yuvan shankar raja tamil song',
  'ilaiyaraaja tamil song',
  'tamil melody songs',
];

@Injectable()
export class YouTubeMusicService implements OnModuleInit {
  private readonly INNERTUBE_API_BASE = 'https://music.youtube.com/youtubei/v1';
  private readonly logger = new Logger(YouTubeMusicService.name);

  constructor(
    private cacheService: CacheService,
    private jioSaavnService: JioSaavnService,
  ) {
    // Pre-warm runs from onModuleInit below.
  }

  onModuleInit() {
    // Staggered fire-and-forget: never blocks boot, never fails boot.
    WARM_QUERIES.forEach((q, i) => {
      const timer = setTimeout(() => {
        this.searchTracks(q).catch(() => undefined);
      }, 8000 + i * 4000);
      const t: any = timer;
      if (t && typeof t.unref === 'function') t.unref();
    });
  }
    // Cloud hosts (especially free tiers) page the ~30MB yt-dlp binary in
    // excruciatingly slowly on first spawn — the health probe watched it
    // take >10s. Warm it once shortly after boot so the first real song
    // doesn't pay that cold-start tax. Fire-and-forget by design.
    const warmTimer = setTimeout(() => {
      this.warmUp().catch(() => undefined);
    }, 5000);
    const wt: any = warmTimer;
    if (wt && typeof wt.unref === 'function') wt.unref();
  }

  private async warmUp(): Promise<void> {
    try {
      await youtubedl('https://www.youtube.com/watch?v=aqz-KE-bpKQ', {
        getUrl: true,
        format: 'bestaudio/bestaudio*',
        noCheckCertificates: true,
        noWarnings: true,
        noPlaylist: true,
        socketTimeout: 25,
        retries: 1,
      });
      this.logger.log('yt-dlp warmed up');
    } catch (error: any) {
      this.logger.warn(`yt-dlp warm-up failed (will retry on demand): ${error?.message || error}`);
    }
  }

  async getAudioStreamDetails(videoId: string, title?: string, artist?: string, quality?: string): Promise<{
    streamUrl: string;
    bitrate: number;
    codec: string;
    mimeType: string;
    qualityLabel: string;
    quality: 'high' | 'medium' | 'low';
    isLossless: boolean;
    source: string;
  } | null> {
    const startTime = Date.now();
    // NOTE: googlevideo URLs expire (typically within hours), so cache for
    // 30 min max — a stale cached URL plays nothing.
    const cacheKey = `audio_details_${videoId}`;
    const cachedDetails = await this.cacheService.get<any>(cacheKey);
    if (cachedDetails) {
      this.logger.log(`Cache hit for audio details: ${videoId} (${Date.now() - startTime}ms)`);
      return cachedDetails;
    }

    this.logger.log(`Cache miss for audio details: ${videoId}, resolving...`);

    try {
      // Primary path: youtube-dl-exec (yt-dlp) resolves the real bestaudio
      // URL reliably. ytdl-core runs ONLY as a lazy fallback below — it is
      // frequently blocked, and an eagerly-created promise for it can reject
      // while unobserved and crash the process.
      const resolveViaYtDlp = async () => {
        const url = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
          getUrl: true,
          format: 'bestaudio/bestaudio*',
          noCheckCertificates: true,
          noWarnings: true,
          noPlaylist: true,
          socketTimeout: 10,
          retries: 2,
          // Datacenter IPs get throttled/blocked on the web player client;
          // the Android client is far less restricted there.
          extractorArgs: 'youtube:player_client=android',
        });
        const resultUrl = typeof url === 'string' ? url.trim() : null;
        if (resultUrl) {
          // youtube-dl -g returns only the URL, so codec is inferred from the
          // URL signature; bitrates are conservative estimates, not claims.
          const isWebm = resultUrl.includes('mime=audio%2Fwebm') || resultUrl.includes('audio/webm');
          return {
            streamUrl: resultUrl,
            bitrate: isWebm ? 160 : 128,
            codec: isWebm ? 'Opus' : 'AAC',
            mimeType: isWebm ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
            qualityLabel: isWebm ? '~160kbps Opus (High)' : '~128kbps AAC (Medium)',
            quality: (isWebm ? 'high' : 'medium') as 'high' | 'medium' | 'low',
            isLossless: false,
            source: 'YouTube Music',
          };
        }
        return null;
      };

      // ytdl-core fallback: richer format metadata when yt-dlp fails.
      // Created lazily inside the fallback branch so a rejection can never
      // go unobserved (which previously crashed the server outright).
      const resolveViaYtdlCore = async () => {
        const info = await ytdl.getInfo(videoId, {
          requestOptions: {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
          }
        });
        const audioOnlyFormats = info.formats
          .filter(format => format.hasAudio && !format.hasVideo && format.url && (format.audioBitrate || 0) > 0)
          .sort((a, b) => {
            const diff = (b.audioBitrate || 0) - (a.audioBitrate || 0);
            if (diff !== 0) return diff;
            // Tie-break toward Opus/webm: better quality per bit than AAC.
            const aOpus = (a.mimeType || '').includes('opus') ? 1 : 0;
            const bOpus = (b.mimeType || '').includes('opus') ? 1 : 0;
            return bOpus - aOpus;
          });

        if (audioOnlyFormats.length > 0 && audioOnlyFormats[0].url) {
          return this.describeAudioFormat(audioOnlyFormats[0]);
        }
        return null;
      };

      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => {
          if (timer) clearTimeout(timer);
        });
      };

      // Race all resolvers: first SUCCESS wins. JioSaavn 320kbps direct CDN
      // URLs resolve in ~1-3s (plain API call, no process spawn) and usually
      // beat yt-dlp's ~9s cold start for Tamil/film songs; yt-dlp stays the
      // reliable fallback, ytdl-core the quick third lane. Every promise is
      // observed from birth (never an unhandled rejection), losers ignored.
      const racers: Array<Promise<any>> = [];
      // Saver mode skips the 320kbps lane on purpose: ~160kbps Opus uses
      // roughly half the bandwidth. 'best' (default) races everything.
      const saver = (quality || '').toLowerCase() === 'saver';
      if (title && !saver) {
        const saavnAttempt = (async () => {
          try {
            const s = await withTimeout(
              this.jioSaavnService.getBestStream(title, artist || ''),
              12000,
            );
            if (!s?.streamUrl) return null;
            return {
              streamUrl: s.streamUrl,
              bitrate: s.bitrate,
              codec: s.codec,
              mimeType: s.mimeType,
              qualityLabel: s.qualityLabel,
              quality: s.quality,
              isLossless: false,
              source: s.source,
            };
          } catch {
            return null;
          }
        })();
        racers.push(saavnAttempt);
      }
      racers.push(
        withTimeout(resolveViaYtDlp(), 20000).catch((error: any) => {
          this.logger.warn(`youtube-dl-exec failed for ${videoId} (${error?.message || error})`);
          return null;
        }),
        withTimeout(resolveViaYtdlCore(), 8000).catch((error: any) => {
          this.logger.warn(`ytdl-core fallback failed for ${videoId} (${error?.message || error})`);
          return null;
        }),
      );
      const tags = title && !saver
        ? ['saavn-320', 'yt-dlp', 'ytdl-core']
        : ['yt-dlp', 'ytdl-core'];
      let details: any = null;
      let pending = racers.length;
      let done = false;
      details = await new Promise<any>((resolve) => {
        const onWin = (d: any, tag: string) => {
          if (done) return;
          if (d) {
            done = true;
            this.logger.log(`${tag} won for ${videoId}`);
            resolve(d);
            return;
          }
          pending -= 1;
          if (pending === 0) {
            done = true;
            resolve(null);
          }
        };
        racers.forEach((p, i) => p.then((d) => onWin(d, tags[i] || `racer-${i}`)));
      });

      if (details) {
        await this.cacheService.set(cacheKey, details, 1800);
        this.logger.log(`Resolved ${details.qualityLabel} for ${videoId} in ${Date.now() - startTime}ms`);
        return details;
      }

      return null;
    } catch (error) {
      this.logger.error(`Error resolving audio stream for videoId ${videoId}:`, error);
      return null;
    }
  }

  private describeAudioFormat(best: any) {
    const bitrate = best.audioBitrate || 128;
    const mimeType: string = best.mimeType || 'audio/webm; codecs="opus"';
    const isOpus = mimeType.includes('opus');
    const rawCodec: string = best.audioCodec || '';
    const codec = isOpus ? 'Opus' : (rawCodec.includes('mp4a') ? 'AAC' : (rawCodec || 'AAC'));
    const quality: 'high' | 'medium' | 'low' = bitrate >= 150 ? 'high' : bitrate >= 100 ? 'medium' : 'low';
    return {
      streamUrl: best.url as string,
      bitrate,
      codec,
      mimeType,
      qualityLabel: `${bitrate}kbps ${codec} (${quality === 'high' ? 'High' : quality === 'medium' ? 'Medium' : 'Low'})`,
      quality,
      // YouTube Music streams are lossy. Never label these lossless/FLAC.
      isLossless: false,
      source: 'YouTube Music',
    };
  }

  async getAudioStreamUrl(videoId: string): Promise<string | null> {
    const details = await this.getAudioStreamDetails(videoId);
    return details?.streamUrl || null;
  }

  async searchTracks(query: string) {
    const startTime = Date.now();
    // Normalize so case/whitespace variants ("Vaathi" vs "vaathi ") share one
    // cache entry — typing the same query twice is then always instant.
    const cacheKey = `search_${(query || '').trim().toLowerCase()}`;
    const cachedResults = await this.cacheService.get<any[]>(cacheKey);
    if (cachedResults) {
      this.logger.log(`Cache hit for search: ${query} (took ${Date.now() - startTime}ms)`);
      return cachedResults;
    }

    this.logger.log(`Searching for: ${query}`);

    const searchCtrl = new AbortController();
    const searchTimer = setTimeout(() => searchCtrl.abort(), 12000);
    try {
      const response = await fetch(`${this.INNERTUBE_API_BASE}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'X-Origin': 'https://music.youtube.com'
        },
        signal: searchCtrl.signal,
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB_REMIX',
              clientVersion: '1.20240101.01.00',
              hl: 'en',
              gl: 'US'
            }
          },
          query,
          params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
        })
      });

      if (!response.ok) {
        throw new Error(`YouTube Music API error: ${response.statusText}`);
      }

      const data: any = await response.json();
      const results = this.parseSearchSongs(data);

      await this.cacheService.set(cacheKey, results, 600);
      clearTimeout(searchTimer);

      // 🚀 BACKGROUND PRE-FETCHING: warm the exact resolvers play uses.
      // Saavn lookups are cheap API calls and always run. YouTube resolves
      // spawn yt-dlp processes — fine on a dev machine, but on free-tier
      // hosting two of those per keystroke stampede the shared CPU and slow
      // the very response being built, so production skips them entirely.
      // Tapping play races Saavn first anyway.
      if (results.length > 0) {
        const top = results.slice(0, 4);
        this.logger.log(`🚀 Pre-fetching audio streams for top ${top.length} search results in background...`);
        for (const track of top) {
          // Fire-and-forget per track; failures only mean a cold resolve later.
          this.jioSaavnService
            .getBestStream(track.title, track.artists)
            .catch((err) => this.logger.warn('Background Saavn pre-fetch warning:', err?.message || err));
        }
        if (process.env.NODE_ENV !== 'production') {
          for (const track of results.slice(0, 2)) {
            this.getAudioStreamDetails(track.id)
              .catch((err) => this.logger.warn('Background YouTube pre-fetch warning:', err?.message || err));
          }
        }
      }

      this.logger.log(`Search completed for "${query}" in ${Date.now() - startTime}ms`);
      return results;
    } catch (error) {
      clearTimeout(searchTimer);
      this.logger.error('YouTube Music Search Error:', error);
      return [
        {
          id: 'suxP321fM5s',
          title: `Search results for "${query}"`,
          artists: 'YouTube Music',
          thumbnail: `https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=1200&q=90`,
          source: 'YouTube Music'
        }
      ];
    }
  }

  private parseSearchSongs(data: any) {
    const results: any[] = [];
    try {
      let contents = [];
      
      if (data?.contents?.tabbedSearchResultsRenderer?.tabs) {
        const tabs = data.contents.tabbedSearchResultsRenderer.tabs;
        for (const tab of tabs) {
          const tabRenderer = tab.tabRenderer;
          if (!tabRenderer) continue;
          
          const content = tabRenderer.content;
          if (!content) continue;
          
          if (content.sectionListRenderer) {
            const sections = content.sectionListRenderer.contents;
            for (const section of sections) {
              if (section.musicShelfRenderer) {
                contents = section.musicShelfRenderer.contents;
                break;
              }
            }
          }
          if (contents.length > 0) break;
        }
      }
      
      if (contents.length === 0 && data?.contents?.sectionListRenderer) {
        const sections = data.contents.sectionListRenderer.contents;
        for (const section of sections) {
          if (section.musicShelfRenderer) {
            contents = section.musicShelfRenderer.contents;
            break;
          }
        }
      }
      
      if (contents.length === 0 && data?.contents?.sectionListRenderer?.contents) {
        const sections = data.contents.sectionListRenderer.contents;
        for (const section of sections) {
          if (section.musicQueueRenderer) {
            contents = section.musicQueueRenderer.content;
            break;
          }
        }
      }

      for (const item of contents) {
        const renderer = item.musicResponsiveListItemRenderer;
        if (!renderer) continue;

        let videoId = null;
        if (renderer.playlistItemData?.videoId) {
          videoId = renderer.playlistItemData.videoId;
        } else if (renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId) {
          videoId = renderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].navigationEndpoint.watchEndpoint.videoId;
        }

        let title = null;
        if (renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text) {
          title = renderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text;
        } else if (renderer.title?.runs?.[0]?.text) {
          title = renderer.title.runs[0].text;
        }

        let artists = '';
        if (renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs) {
          const artistRuns = renderer.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs;
          const rawText = artistRuns.map((r: any) => r.text).filter(Boolean).join('');
          artists = rawText
            .replace(/,\s*&\s*,?/g, ' & ')
            .replace(/,\s*•\s*,?/g, ' • ')
            .replace(/\s*,\s*,+/g, ', ')
            .replace(/,\s*&/g, ' &')
            .trim();
        } else if (renderer.subtitle?.runs?.[0]?.text) {
          artists = renderer.subtitle.runs[0].text;
        }

        let thumbnail = '';
        let thumbnails = [];

        if (renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails) {
          thumbnails = renderer.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails;
        } else if (renderer.thumbnail?.thumbnails) {
          thumbnails = renderer.thumbnail.thumbnails;
        } else if (renderer.thumbnails) {
          thumbnails = renderer.thumbnails;
        }

        if (thumbnails.length > 0) {
          const sortedThumbnails = [...thumbnails].sort((a, b) => {
            const areaA = (a.width || 0) * (a.height || 0);
            const areaB = (b.width || 0) * (b.height || 0);
            return areaB - areaA;
          });

          let bestThumbnailUrl = sortedThumbnails[0]?.url || '';
          if (bestThumbnailUrl && bestThumbnailUrl.includes('yt3.googleusercontent.com')) {
            // Request a modest size: w1920 files (~350KB each) made every
            // cover in lists/grids load slowly. w500 (~30-60KB) is still
            // retina-crisp for the largest in-app artwork (320px player art).
            bestThumbnailUrl = bestThumbnailUrl.replace(/=w\d+-h\d+-l\d+-rj/, '=w500-h500-l90-rj');
          }
          thumbnail = bestThumbnailUrl;
        }

        if (!thumbnail && videoId) {
          // NOTE: maxresdefault.jpg 404s for videos without HD thumbnails
          // (very common) and the player then shows its fallback tile.
          // hqdefault.jpg is guaranteed to exist for every video.
          thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        }

        if (!thumbnail) {
          thumbnail = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&q=80';
        }

        if (videoId && title) {
          results.push({
            id: videoId,
            title,
            artists,
            thumbnail,
            source: 'YouTube Music',
            audioQuality: 'Best available • up to 320kbps'
          });
        }
      }
    } catch (e) {
      console.error('Error parsing YT Music search response:', e);
    }
    return results;
  }
}
