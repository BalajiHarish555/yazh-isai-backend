import { Controller, Get, Query } from '@nestjs/common';
import { StreamHealthService } from './stream-health.service';

@Controller('health')
export class StreamHealthController {
  constructor(private readonly streamHealthService: StreamHealthService) {}

  /**
   * Dependency health for everything playback needs: the yt-dlp binary,
   * Saavn + Lrclib reachability. Add ?deep=true for a real end-to-end
   * extraction (result cached 1h so monitors stay cheap).
   */
  @Get('stream')
  async streamHealth(@Query('deep') deep?: string) {
    return this.streamHealthService.check(deep === 'true' || deep === '1');
  }
}
