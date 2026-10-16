import { Module } from '@nestjs/common';
import { EchoAddonController } from './echo-addon.controller';
import { TracksModule } from '../tracks/tracks.module';
import { CacheModule } from '../../common/cache.module';

// Compatibility layer for the Echo Music Android app's addon protocol
// (/search, /stream/:id, /stream?id=). Reuses TracksModule's singleton
// YouTubeMusicService (no duplicate warmup) plus CacheModule for oEmbed.
@Module({
  imports: [TracksModule, CacheModule],
  controllers: [EchoAddonController],
})
export class EchoAddonModule {}
