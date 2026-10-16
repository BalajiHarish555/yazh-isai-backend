import { Module } from '@nestjs/common';
import { ArtistsModule } from './artists/artists.module';
import { TracksModule } from './tracks/tracks.module';
import { EchoAddonModule } from './echo-addon/echo-addon.module';

@Module({
  imports: [ArtistsModule, TracksModule, EchoAddonModule],
})
export class CatalogModule {}
