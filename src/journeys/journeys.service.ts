import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { RecommendationService } from '../discovery/recommendation.service';
import { MoodEngineService } from '../discovery/mood-engine.service';

export interface JourneyStage {
  name: string;
  energy: number;
  mood: string;
  durationMinutes: number;
}

export interface Journey {
  id?: string;
  name: string;
  description: string;
  stages: JourneyStage[];
}

@Injectable()
export class JourneysService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private recService: RecommendationService,
    private moodEngine: MoodEngineService,
  ) {}

  async createJourney(userId: string, data: Journey) {
    // V1: We generate a "virtual journey" by selecting tracks for each stage
    const journeyTracks = [];
    
    for (const stage of data.stages) {
      // Use a range around the target energy for each stage
      const candidateTracks = await this.prisma.track.findMany({
        where: {
          energy: {
            gte: Math.max(0, stage.energy - 0.2),
            lte: Math.min(1, stage.energy + 0.2),
          },
        },
        include: { artists: { include: { artist: true } } },
      });

      const matchedTracks = candidateTracks.filter((t: any) => {
        const moods = Array.isArray(t.mood) ? t.mood : (typeof t.mood === 'string' ? JSON.parse(t.mood || '[]') : []);
        return moods.includes(stage.mood);
      });

      const neededCount = Math.max(1, Math.ceil(stage.durationMinutes / 4));
      const tracks = matchedTracks.length > 0 ? matchedTracks.slice(0, neededCount) : candidateTracks.slice(0, neededCount);
      
      journeyTracks.push({
        stage: stage.name,
        tracks: tracks,
      });
    }

    return {
      name: data.name,
      description: data.description,
      timeline: journeyTracks,
    };
  }

  async getSuggestedJourneys() {
    return [
      {
        name: 'Night Drive',
        description: 'A smooth transition from urban energy to midnight peace.',
        stages: [
          { name: 'Start', energy: 0.4, mood: 'chill', durationMinutes: 10 },
          { name: 'Peak', energy: 0.8, mood: 'energy', durationMinutes: 20 },
          { name: 'Wind Down', energy: 0.3, mood: 'dreamy', durationMinutes: 15 },
          { name: 'Stillness', energy: 0.1, mood: 'peaceful', durationMinutes: 10 },
        ],
      },
      {
        name: 'Deep Focus',
        description: 'A journey into the flow state for maximum productivity.',
        stages: [
          { name: 'Warming Up', energy: 0.3, mood: 'focus', durationMinutes: 15 },
          { name: 'Deep Flow', energy: 0.2, mood: 'peaceful', durationMinutes: 45 },
          { name: 'Break', energy: 0.5, mood: 'chill', durationMinutes: 10 },
        ],
      },
    ];
  }
}
