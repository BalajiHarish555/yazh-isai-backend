import { Module } from '@nestjs/common';
import { DeezerService } from './deezer.service';
import { DeezerController } from './deezer.controller';
import { CacheModule } from '../common/cache.module';

@Module({
  imports: [CacheModule],
  controllers: [DeezerController],
  providers: [DeezerService],
  exports: [DeezerService],
})
export class DeezerModule {}
