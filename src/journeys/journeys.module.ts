import { Module } from '@nestjs/common';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  imports: [DiscoveryModule],
  controllers: [JourneysController],
  providers: [JourneysService],
  exports: [JourneysService],
})
export class JourneysModule {}
