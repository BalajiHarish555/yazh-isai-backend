import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StreamHealthService } from './stream-health.service';

@Controller('health')
export class StreamHealthController {
  constructor(private readonly streamHealthService: StreamHealthService) {}

  /**
   * Dependency health for everything playback needs: the yt-dlp binary,
   * Saavn + Lrclib reachability. Add ?deep=true for a real end-to-end
   * extraction (result cached 1h so monitors stay cheap).
   * Throttled: ?deep=true spawns real yt-dlp extractions.
   */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('stream')
  async streamHealth(@Query('deep') deep?: string) {
    return this.streamHealthService.check(deep === 'true' || deep === '1');
  }
}
