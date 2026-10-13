import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { DeezerService } from './deezer.service';

// Deezer track ids are numeric strings; reject anything else (SSRF guard).
const TRACK_ID_RE = /^[0-9]{1,15}$/;

@Controller('deezer')
export class DeezerController {
  constructor(private readonly deezerService: DeezerService) {}

  /**
   * Decrypting FLAC proxy. Serves a full-length lossless stream, honoring
   * Range requests, and transparently decrypting Deezer's BF_CBC_STRIPE
   * stripes so the browser receives plain FLAC.
   */
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('stream/:id')
  async stream(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!TRACK_ID_RE.test(id || '')) {
      res.status(400).send('Invalid track id');
      return;
    }
    if (!this.deezerService.isEnabled()) {
      res.status(404).send('Deezer FLAC is not configured (set DEEZER_ARL)');
      return;
    }

    const result = await this.deezerService.proxyStream(id, req.headers.range);

    if (!result.stream) {
      if (!res.headersSent) res.status(result.status).send('Stream not available');
      return;
    }

    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers)) {
      res.setHeader(k, v);
    }
    // Same-origin: allow the Web Audio EQ graph to consume it.
    res.setHeader('Access-Control-Allow-Origin', '*');

    result.stream.pipe(res);
    // If the client disconnects, stop pulling from upstream.
    res.on('close', () => {
      (result.stream as any)?.destroy?.();
    });
  }

  /** Health/status probe so the frontend can tell if FLAC is available. */
  @Get('status')
  async status() {
    return { enabled: this.deezerService.isEnabled() };
  }
}
