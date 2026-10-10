import { Module } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { YouTubeMusicService } from '../youtube-music.service';
import { JioSaavnService } from '../jiosaavn.service';
import { CacheModule } from '../../common/cache.module';

@Module({
  controllers: [TracksController],
  providers: [TracksService, YouTubeMusicService, JioSaavnService],
  imports: [CacheModule],
  exports: [TracksService],
})
export class TracksModule {}
