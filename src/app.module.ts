import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { LibraryModule } from './library/library.module';
import { PlaylistsModule } from './playlists/playlists.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AIModule } from './ai/ai.module';
import { JourneysModule } from './journeys/journeys.module';
import { CacheModule } from './common/cache.module';
import { LyricsModule } from './lyrics/lyrics.module';
import { ProfilesModule } from './profiles/profiles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Global abuse protection. Defaults are generous for normal app use;
    // expensive routes (stream/proxy/search/lyrics) set tighter budgets
    // via @Throttle on their controllers.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60000, limit: 120 }],
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      // NOTE: a plain '/api*' string crashes this package's path-to-regexp
      // on every miss (500 instead of 404). A RegExp is handled natively
      // at runtime (cast: this version's typings only declare string[]).
      exclude: [/^\/api\//] as unknown as string[],
    }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    CatalogModule,
    LibraryModule,
    PlaylistsModule,
    DiscoveryModule,
    AIModule,
    JourneysModule,
    CacheModule,
    LyricsModule,
    ProfilesModule,
  ],
  controllers: [],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}







