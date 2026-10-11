import { Injectable, Logger } from '@nestjs/common';
import youtubedl from 'youtube-dl-exec';
import fetch from 'node-fetch';
import { CacheService } from '../common/cache.service';

export interface ProbeResult {
  ok: boolean;
  ms: number;
  detail?: string;
}

// Canonical long-stable test video (Big Buck Bunny, Blender Foundation).
const DEEP_CHECK_VIDEO = process.env.HEALTH_CHECK_VIDEO_ID || 'aqz-KE-bpKQ';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

@Injectable()
export class StreamHealthService {
  private readonly logger = new Logger(StreamHealthService.name);

  constructor(private cacheService: CacheService) {}

  private async probe(name: string, fn: () => Promise<string | void>): Promise<ProbeResult> {
    const start = Date.now();
    try {
      const detail = await withTimeout(fn(), 10000, name);
      return { ok: true, ms: Date.now() - start, detail: detail || undefined };
    } catch (error: any) {
      this.logger.warn(`Stream health probe failed (${name}): ${error?.message || error}`);
      return { ok: false, ms: Date.now() - start, detail: error?.message || String(error) };
    }
  }

  async check(deep: boolean) {
    const start = Date.now();
    const [ytdlp, saavn, lrclib] = await Promise.all([
      this.probe('yt-dlp binary', async () => {
        const out = await youtubedl('', { version: true } as any);
        return typeof out === 'string' ? out.trim().split('\n')[0] : 'ok';
      }),
      this.probe('saavn search', async () => {
        const res = await fetch(
          'https://www.jiosaavn.com/api.php?__call=search.getResults&q=test&p=1&n=1&_format=json&_marker=0&api_version=4&ctx=web6dot0',
          { headers: { 'User-Agent': 'yzh-health-check/1.0', Referer: 'https://www.jiosaavn.com/' } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }),
      this.probe('lrclib search', async () => {
        const res = await fetch('https://lrclib.net/api/search?q=test', {
          headers: { 'User-Agent': 'yzh-health-check/1.0' },
        });
        if (!res.ok && res.status !== 503 && res.status !== 429) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (res.status === 503 || res.status === 429) throw new Error('overloaded/busy');
      }),
    ]);

    let extraction: ProbeResult | undefined;
    if (deep) {
      const cacheKey = 'health_deep_extraction';
      const cached = await this.cacheService.get<ProbeResult>(cacheKey);
      if (cached) {
        extraction = { ...cached, detail: `${cached.detail || ''} (cached)`.trim() };
      } else {
        extraction = await this.probe('yt-dlp extraction', async () => {
          const url = await withTimeout(
            youtubedl(`https://www.youtube.com/watch?v=${DEEP_CHECK_VIDEO}`, {
              getUrl: true,
              format: 'bestaudio/bestaudio*',
              noCheckCertificates: true,
              noWarnings: true,
              noPlaylist: true,
            }) as Promise<unknown>,
            25000,
            'extraction',
          );
          if (typeof url !== 'string' || !url.startsWith('http')) {
            throw new Error('no stream URL resolved');
          }
          return 'stream URL resolved';
        });
        // Cache the verdict for an hour — monitors poll often, upstream shouldn't pay each time.
        await this.cacheService.set(cacheKey, extraction, 3600);
      }
    }

    const checks: Record<string, ProbeResult> = { ytdlp, saavn, lrclib };
    if (extraction) checks.extraction = extraction;
    const ok = Object.values(checks).every((c) => c.ok);
    return { ok, ms: Date.now() - start, checks };
  }
}
