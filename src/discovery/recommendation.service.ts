import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { MoodEngineService } from './mood-engine.service';
import { CacheService } from '../common/cache.service';

@Injectable()
export class RecommendationService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private moodEngine: MoodEngineService,
    private cache: CacheService,
  ) {}

  async recommendByMood(userId: string, moodId: string) {
    const cacheKey = `mood:${moodId}:tracks`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const params = this.moodEngine.getParamsForMood(moodId);
    
    const candidateTracks = await this.prisma.track.findMany({
      where: {
        energy: {
          gte: params.energy.min,
          lte: params.energy.max,
        },
        tempo: {
          gte: params.tempo.min,
          lte: params.tempo.max,
        },
      },
      include: { artists: { include: { artist: true } } },
      take: 50,
    });

    const tracks = candidateTracks.filter((t: any) => {
      const moods = Array.isArray(t.mood) ? t.mood : (typeof t.mood === 'string' ? JSON.parse(t.mood || '[]') : []);
      return params.moods.some(m => moods.includes(m));
    }).slice(0, 20);

    const finalTracks = tracks.length > 0 ? tracks : candidateTracks.slice(0, 20);

    await this.cache.set(cacheKey, finalTracks, 600); // Cache mood tracks for 10 mins
    return finalTracks;
  }

  async getPersonalizedHome(userId: string) {
    const cacheKey = `home:user:${userId}`;
    const cachedHome = await this.cache.get(cacheKey);
    if (cachedHome) return cachedHome;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { preferences: true },
    });

    const rawMoods = user?.preferences?.preferredMoods;
    const preferredMoodsArr = rawMoods ? (typeof rawMoods === 'string' ? JSON.parse(rawMoods) : rawMoods) : ['chill'];
    const preferredMood = preferredMoodsArr[0] || 'chill';
    const moodTracks = await this.recommendByMood(userId, preferredMood);

    const trendingTracks = await this.prisma.track.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { artists: { include: { artist: true } } },
    });

    const home = {
      sections: [
        {
          type: 'hero',
          title: 'Your Night',
          subtitle: `Curated ${preferredMood} vibes for you`,
          tracks: moodTracks,
        },
        {
          type: 'trending',
          title: 'Trending Now',
          items: trendingTracks,
        },
        {
          type: 'discovery',
          title: 'Hidden Gems',
          items: await this.getHiddenGems(),
        },
      ],
    };

    await this.cache.set(cacheKey, home, 300); // Cache home feed for 5 mins
    return home;
  }

  private async getHiddenGems() {
    return this.prisma.track.findMany({
      where: { energy: { gte: 0.6 } },
      take: 10,
      include: { artists: { include: { artist: true } } },
    });
  }
}

