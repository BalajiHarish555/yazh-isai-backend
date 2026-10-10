import { Module } from '@nestjs/common';
import { LyricsService } from './lyrics.service';
import { LyricsController } from './lyrics.controller';
import { CacheModule } from '../common/cache.module';
import { LrcLibLyricsProvider } from './providers/lrclib.provider';
import { BetterLyricsLyricsProvider } from './providers/betterlyrics.provider';
import { LyricsOvhLyricsProvider } from './providers/lyricsovh.provider';

@Module({
  imports: [CacheModule],
  controllers: [LyricsController],
  providers: [
    LyricsService,
    LrcLibLyricsProvider,
    BetterLyricsLyricsProvider,
    LyricsOvhLyricsProvider,
  ],
  exports: [LyricsService],
})
export class LyricsModule {}