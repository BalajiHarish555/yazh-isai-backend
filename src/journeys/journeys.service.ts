import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { RecommendationService } from '../discovery/recommendation.service';
import { MoodEngineService } from '../discovery/mood-engine.service';

function safeMoods(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.filter((m): m is string => typeof m === 'string');
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
    }
  } catch {
    // Corrupt row — treat as unmoodable rather than 500ing the journey.
  }
  return [];
}

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
    if (!data || !Array.isArray(data.stages) || data.stages.length === 0) {
      throw new BadRequestException('Journey stages are required');
    }
    const journeyTracks = [];

    for (const raw of data.stages.slice(0, 10)) {
      const energy = Number(raw?.energy);
      const stage = {
        name: typeof raw?.name === 'string' ? raw.name.slice(0, 100) : 'Stage',
        energy: Number.isFinite(energy) ? Math.max(0, Math.min(1, energy)) : 0.5,
        mood: typeof raw?.mood === 'string' ? raw.mood.slice(0, 50) : 'chill',
        durationMinutes: Number.isFinite(Number(raw?.durationMinutes))
          ? Math.max(1, Math.min(180, Math.floor(Number(raw.durationMinutes))))
          : 10,
      };
      // Use a range around the target energy for each stage
      const candidateTracks = await this.prisma.track.findMany({
        where: {
          energy: {
            gte: Math.max(0, stage.energy - 0.2),
            lte: Math.min(1, stage.energy + 0.2),
          },
        },
        include: { artists: { include: { artist: true } } },
        take: 100,
      });

      const matchedTracks = candidateTracks.filter((t: any) => {
        return safeMoods(t.mood).includes(stage.mood);
      });

      const neededCount = Math.max(1, Math.ceil(stage.durationMinutes / 4));
      const tracks = matchedTracks.length > 0 ? matchedTracks.slice(0, neededCount) : candidateTracks.slice(0, neededCount);

      journeyTracks.push({
        stage: stage.name,
        tracks: tracks,
      });
    }

    return {
      name: typeof data?.name === 'string' ? data.name.slice(0, 100) : 'Journey',
      description: typeof data?.description === 'string' ? data.description.slice(0, 500) : '',
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
