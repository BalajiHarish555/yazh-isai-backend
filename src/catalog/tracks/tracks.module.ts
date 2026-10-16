import { Module } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { YouTubeMusicService } from '../youtube-music.service';
import { JioSaavnService } from '../jiosaavn.service';
import { DeezerModule } from '../deezer.module';
import { TidalModule } from '../tidal.module';
import { CacheModule } from '../../common/cache.module';

@Module({
  controllers: [TracksController],
  providers: [TracksService, YouTubeMusicService, JioSaavnService],
  // DeezerModule exports DeezerService (injected into YouTubeMusicService as
  // the top-quality FLAC lane) and registers the /deezer/stream proxy.
  // TidalModule provides TidalService as another lossless FLAC source.
  imports: [CacheModule, DeezerModule, TidalModule],
  // YouTubeMusicService is shared with EchoAddonModule (Echo app compat);
  // JioSaavnService is shared with DiscoveryModule (Reels feed charts).
  exports: [TracksService, YouTubeMusicService, JioSaavnService],
})
export class TracksModule {}
