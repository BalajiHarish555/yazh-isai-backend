import { Module } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { YouTubeMusicService } from '../youtube-music.service';
import { JioSaavnService } from '../jiosaavn.service';
import { DeezerModule } from '../deezer.module';
import { CacheModule } from '../../common/cache.module';

@Module({
  controllers: [TracksController],
  providers: [TracksService, YouTubeMusicService, JioSaavnService],
  // DeezerModule exports DeezerService (injected into YouTubeMusicService as
  // the top-quality FLAC lane) and registers the /deezer/stream proxy.
  imports: [CacheModule, DeezerModule],
  exports: [TracksService],
})
export class TracksModule {}
