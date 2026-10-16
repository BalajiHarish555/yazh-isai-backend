import { Module } from '@nestjs/common';
import { TidalService } from './tidal.service';
import { TidalController } from './tidal.controller';
import { CacheModule } from '../common/cache.module';

@Module({
  imports: [CacheModule],
  controllers: [TidalController],
  providers: [TidalService],
  exports: [TidalService],
})
export class TidalModule {}
