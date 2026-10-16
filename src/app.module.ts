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
      // MUST be a bare RegExp (the option's `string[] | RegExp` union), not
      // an array of RegExps: this package's isRouteExcluded() only special-
      // cases `paths instanceof RegExp` and runs path-to-regexp() on every
      // array element — a RegExp *element* crashes path-to-regexp 8 and
      // turns every SPA deep link / unknown GET into a 500.
      exclude: /^\/api\//,
      serveStaticOptions: {
        // Entry files must never cache: a stale index.html boots a stale
        // bundle (the classic "I don't see the new UI" bug). Hashed assets
        // are content-addressed, so they cache immutably instead.
        setHeaders: (res, filePath) => {
          if (/index\.html$|sw\.js$|manifest.*\.json$/.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      },
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







