import { Module } from '@nestjs/common';
import { ArtistsModule } from './artists/artists.module';
import { TracksModule } from './tracks/tracks.module';

@Module({
  imports: [ArtistsModule, TracksModule],
})
export class CatalogModule {}
