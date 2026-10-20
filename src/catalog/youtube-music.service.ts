import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import youtubedl from 'youtube-dl-exec';
import fetch from 'node-fetch';
import { CacheService } from '../common/cache.service';
import { JioSaavnService } from './jiosaavn.service';
import { DeezerService } from './deezer.service';
import { TidalService } from './tidal.service';

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
    private deezerService: DeezerService,
    private tidalService: TidalService,
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
         format: 'bestaudio[acodec*=opus]/bestaudio[acodec*=aac]/bestaudio/bestaudio*',
         formatSort: ['abr', 'codec'],
         noCheckCertificates: true,
         noWarnings: true,
         noPlaylist: true,
         socketTimeout: 25,
         retries: 1,
         extractorArgs: 'youtube:player_client=android,web',
       });
       this.logger.log('yt-dlp warmed up with quality formats');
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
    resolvedQuality: 'best' | 'saver';
  } | null> {
    const startTime = Date.now();
    const saver = (quality || '').toLowerCase() === 'saver';
    // NOTE: googlevideo URLs expire (typically within hours), so cache for
    // 30 min max — a stale cached URL plays nothing. Quality is part of the
    // key so a 'saver' hit can never satisfy a 'best' request (and vice
    // versa) for 30 minutes.
    // Title is part of the key too: the lossless/high-quality lanes
    // (Deezer/Tidal/Saavn) need title+artist to search. A title-less
    // background warmup must never poison the cache with a YouTube-AAC
    // result that later shadows a titled request's FLAC/Saavn resolution.
    const titleKey =
      (title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32) || 'notitle';
    const cacheKey = `audio_details_${videoId}_${saver ? 'saver' : 'best'}_${titleKey}`;
    const cachedDetails = await this.cacheService.get<any>(cacheKey);
    if (cachedDetails) {
      this.logger.log(`Cache hit for audio details: ${videoId} (${Date.now() - startTime}ms)`);
      return cachedDetails;
    }

    this.logger.log(`Cache miss for audio details: ${videoId}, resolving...`);

    try {
       // Primary path: youtube-dl-exec (yt-dlp) resolves the real bestaudio
       // URL reliably. dumpSingleJson (instead of getUrl) returns the full
       // format metadata INCLUDING the measured bitrate, so quality labels
       // reflect reality instead of a hardcoded guess.
       const resolveViaYtDlp = async () => {
       const info = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
         dumpSingleJson: true,
         // Prefer highest bitrate available: Opus (better quality-per-bit) first,
         // then AAC. Sort by abr descending so yt-dlp picks the top rung even
         // when multiple formats satisfy a filter. YouTube caps ~256kbps on
         // the free tiers; premium/Android client can expose ~320kbps+.
         format: 'bestaudio[acodec*=opus]/bestaudio[acodec*=aac]/bestaudio/bestaudio*',
         formatSort: ['abr', 'codec'],
         noCheckCertificates: true,
         noWarnings: true,
         noPlaylist: true,
         socketTimeout: 10,
         retries: 2,
         // Android + web clients expose the widest (and highest-bitrate) set
         // of audio formats on datacenter IPs.
         extractorArgs: 'youtube:player_client=android,web',
       });
            // info may be a parsed object (youtube-dl-exec default) or a JSON string
            let meta: any = null;
            if (typeof info === 'string') {
              try { meta = JSON.parse(info); } catch { meta = null; }
            } else if (info && typeof info === 'object') {
              meta = info;
            }
            const resultUrl = typeof meta?.url === 'string' ? meta.url.trim() : null;
            if (resultUrl) {
              // Real bitrate from yt-dlp's format metadata (abr = audio bitrate).
              // Fall back to conservative estimates when abr is missing.
              const abr = Number(meta.abr || meta.tbr || 0);
              const estimatedBitrate = abr > 0 ? Math.round(abr) : 128;
              const isWebm = resultUrl.includes('mime=audio%2Fwebm') || resultUrl.includes('audio/webm') ||
                meta.ext === 'webm' || (meta.acodec || '').includes('opus');
              const codec = isWebm ? 'Opus' : 'AAC';
              return {
                streamUrl: resultUrl,
                bitrate: estimatedBitrate,
                codec,
                mimeType: isWebm ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
                qualityLabel: `${codec} (${estimatedBitrate}kbps)`,
                quality: (estimatedBitrate >= 256 ? 'high' : estimatedBitrate >= 160 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
                isLossless: false,
                source: 'YouTube Music',
                resolvedQuality: (saver ? 'saver' : 'best') as 'best' | 'saver',
              };
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

     // Lossless FLAC lane: Prioritize lossless sources first for best quality.
        // Deezer and Tidal race in parallel (was sequential — a slow miss on
        // the first doubled every lossless attempt's latency); Deezer wins
        // ties. Only for 'best' requests; failures fall through to
        // Saavn/YouTube below so nothing regresses.
        if (title && !saver) {
          const [deezerFlac, tidalFlac] = await Promise.allSettled([
            this.deezerService.getBestFlacStream(title, artist || ''),
            this.tidalService.getBestFlacStream(title, artist || ''),
          ]).then(([dz, td]) => [
            dz.status === 'fulfilled' ? dz.value : null,
            td.status === 'fulfilled' ? td.value : null,
          ] as const);
          const flac = deezerFlac || tidalFlac;
          if (flac?.streamUrl) {
            const details = {
              streamUrl: flac.streamUrl,
              bitrate: flac.bitrate,
              codec: flac.codec,
              mimeType: flac.mimeType,
              qualityLabel: flac.qualityLabel,
              quality: flac.quality,
              isLossless: true,
              source: flac.source,
              resolvedQuality: 'best' as const,
            };
            await this.cacheService.set(cacheKey, details, 21600);
            this.logger.log(
              `${flac.source} FLAC authoritative for ${videoId} in ${Date.now() - startTime}ms`,
            );
            return details;
          }
          
          // Check if we have a lossless indicator from other sources
          // (This would be enhanced if we had more metadata about lossless availability)
        }

      // Saavn is the lossy quality ceiling (up to 320kbps verified AAC) and
      // resolves in ~1-3s (plain API call, no process spawn). It is tried
      // FIRST and wins on success — yt-dlp (~9s cold spawn) is the true
      // fallback, ytdl-core the last resort. This makes the 320 lane
      // authoritative instead of racing, so 'best' actually gets 320 whenever
      // Saavn has a confident match.
      if (title) {
        const saavn = await this.jioSaavnService
          .getBestStream(title, artist || '', saver ? 'saver' : 'best')
          .catch(() => null);
        if (saavn?.streamUrl) {
          const details = {
            streamUrl: saavn.streamUrl,
            bitrate: saavn.bitrate,
            codec: saavn.codec,
            mimeType: saavn.mimeType,
            qualityLabel: saavn.qualityLabel,
            quality: saavn.quality,
            isLossless: false,
            source: saavn.source,
            resolvedQuality: (saver ? 'saver' : 'best') as 'best' | 'saver',
          };
          await this.cacheService.set(cacheKey, details, 1800);
          this.logger.log(
            `Saavn ${saavn.bitrate}kbps authoritative for ${videoId} in ${Date.now() - startTime}ms`,
          );
          return details;
        }
      }

      // YouTube fallback: yt-dlp is the sole resolver. ytdl-core was removed
      // as a racer because YouTube's cipher changes routinely break its
      // decipher/n-transform parsing — it always lost after burning an
      // 8-second timeout on every request.
      const ytDetails = await withTimeout(resolveViaYtDlp(), 15000).catch((error: any) => {
        this.logger.warn(`youtube-dl-exec failed for ${videoId} (${error?.message || error})`);
        return null;
      });

      if (ytDetails) {
        await this.cacheService.set(cacheKey, ytDetails, 1800);
        this.logger.log(`Resolved ${ytDetails.qualityLabel} for ${videoId} in ${Date.now() - startTime}ms`);
        return ytDetails;
      }

      return null;
    } catch (error) {
      this.logger.error(`Error resolving audio stream for videoId ${videoId}:`, error);
      return null;
    }
  }

  async getAudioStreamUrl(
    videoId: string,
    title?: string,
    artist?: string,
    quality?: string,
  ): Promise<string | null> {
    const details = await this.getAudioStreamDetails(videoId, title, artist, quality);
    return details?.streamUrl || null;
  }

  /**
   * Lossless-by-title lane for catalog ids that never reach the YouTube-ID
   * FLAC path (e.g. saavn-* ids, which otherwise settle for 160/320 AAC).
   * Deezer and Tidal race in parallel; the first FLAC hit wins and is
   * cached 6h. Callers fall back to their lossy source on null.
   */
  async resolveLosslessByTitle(title?: string, artist?: string) {
    const t = (title || '').trim();
    if (t.length < 3) return null;
    const a = (artist || '').trim();
    const cacheKey = `flac_t_${Buffer.from(`${t}|${a}`.toLowerCase()).toString('base64url').slice(0, 24)}`;
    const cached = await this.cacheService.get<any>(cacheKey).catch(() => null);
    if (cached?.streamUrl) return cached;

    const [dz, td] = await Promise.allSettled([
      this.deezerService.getBestFlacStream(t, a),
      this.tidalService.getBestFlacStream(t, a),
    ]);
    const hit =
      (dz.status === 'fulfilled' ? dz.value : null) ||
      (td.status === 'fulfilled' ? td.value : null);
    if (!hit?.streamUrl) return null;
    const details = {
      streamUrl: hit.streamUrl,
      bitrate: hit.bitrate,
      codec: hit.codec,
      mimeType: hit.mimeType,
      qualityLabel: hit.qualityLabel,
      quality: hit.quality,
      isLossless: true,
      source: hit.source,
      resolvedQuality: 'best' as const,
    };
    await this.cacheService.set(cacheKey, details, 21600).catch(() => undefined);
    this.logger.log(`Lossless-by-title hit for "${t}" via ${hit.source}`);
    return details;
  }

  private parseDurationLabel(label: string): number | undefined {
    const parts = (label || '').trim().split(':').map((p) => parseInt(p, 10));
    if (parts.some((n) => !Number.isFinite(n))) return undefined;
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    return total > 0 ? total : undefined;
  }

  /**
   * YouTube Music's own Up Next queue (the `next` InnerTube endpoint with
   * the RD autoplay list): what YT itself would play after this video.
   * First item is the seed video — skipped. Cached 10 min per video.
   */
  async getYouTubeUpNext(videoId: string, limit = 12): Promise<any[]> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return [];
    const startTime = Date.now();
    const cacheKey = `upnext_${videoId}`;
    const cached = await this.cacheService.get<any[]>(cacheKey);
    if (cached && cached.length > 0) {
      this.logger.log(`Cache hit for up-next: ${videoId} (${Date.now() - startTime}ms)`);
      return cached.slice(0, limit);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const response = await fetch(`${this.INNERTUBE_API_BASE}/next`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'X-Origin': 'https://music.youtube.com',
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB_REMIX',
              clientVersion: '1.20240101.01.00',
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
          playlistId: `RD${videoId}`,
          params: 'wAEB',
        }),
      });
      if (!response.ok) throw new Error(`InnerTube next error: ${response.statusText}`);
      const data: any = await response.json();
      const tabs: any[] =
        data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
          ?.watchNextTabbedResultsRenderer?.tabs || [];
      const queueTab = tabs.find(
        (t: any) => t?.tabRenderer?.content?.musicQueueRenderer,
      );
      const items: any[] =
        queueTab?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents || [];

      const out: any[] = [];
      const seen = new Set<string>([videoId]);
      for (const entry of items) {
        const v = entry?.playlistPanelVideoRenderer;
        const id = v?.videoId;
        const title = v?.title?.runs?.[0]?.text?.trim();
        if (!id || !title || seen.has(id)) continue;
        seen.add(id);
        const artistRuns: any[] = v?.shortBylineText?.runs || v?.longBylineText?.runs || [];
        const artists = artistRuns
          .map((r: any) => r?.text)
          .filter(Boolean)
          .join('')
          .replace(/\s*,\s*,+/g, ', ')
          .trim();
        const thumbs: any[] = v?.thumbnail?.thumbnails || v?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        let thumbnail = '';
        if (thumbs.length > 0) {
          const best = [...thumbs].sort(
            (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
          )[0];
          thumbnail = (best?.url || '').replace(/=w\d+-h\d+-l\d+-rj/, '=w500-h500-l90-rj');
        }
        if (!thumbnail) thumbnail = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        const lenRuns: any[] = v?.lengthText?.runs || [];
        const duration = this.parseDurationLabel(lenRuns.map((r: any) => r?.text).join(''));
        out.push({
          id,
          title,
          artists: artists || 'Unknown Artist',
          thumbnail,
          duration,
          source: 'Up Next • YouTube Music',
          reason: 'Up next on YouTube Music',
        });
        if (out.length >= limit * 2) break;
      }
      if (out.length > 0) {
        await this.cacheService.set(cacheKey, out, 600);
      }
      this.logger.log(`Up-next for ${videoId}: ${out.length} tracks in ${Date.now() - startTime}ms`);
      return out.slice(0, limit);
    } catch (error: any) {
      this.logger.warn(`YouTube up-next failed for ${videoId}: ${error?.message || error}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
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
            // Pass title/artists so warmup heats the high-quality lanes
            // (Saavn/FLAC) for these tracks instead of caching a
            // title-less YouTube result.
            this.getAudioStreamDetails(track.id, track.title, track.artists)
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
          const artistNames = artistRuns
            .filter((r: any) => {
              const cfg = r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig;
              return cfg?.pageType === 'MUSIC_PAGE_TYPE_ARTIST';
            })
            .map((r: any) => r.text)
            .filter(Boolean);
          if (artistNames.length > 0) {
            artists = Array.from(new Set(artistNames)).join(' & ');
          } else {
            const rawText = artistRuns.map((r: any) => r.text).filter(Boolean).join('');
            artists = rawText
              .split(/\s*\u00a0+|\s*•\s*/)
              .map((s: string) => s.trim())
              .filter(Boolean)[0] || rawText.trim();
          }
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
