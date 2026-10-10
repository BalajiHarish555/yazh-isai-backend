import { Injectable } from '@nestjs/common';

export interface MoodParameters {
  moods: string[];
  energy: { min: number; max: number };
  tempo: { min: number; max: number };
}

@Injectable()
export class MoodEngineService {
  private readonly moodMap: Record<string, MoodParameters> = {
    dreamy: {
      moods: ['dreamy', 'peaceful'],
      energy: { min: 0.1, max: 0.4 },
      tempo: { min: 60, max: 100 },
    },
    energy: {
      moods: ['energetic', 'happy'],
      energy: { min: 0.7, max: 1.0 },
      tempo: { min: 120, max: 180 },
    },
    focus: {
      moods: ['focused', 'peaceful', 'chill'],
      energy: { min: 0.2, max: 0.5 },
      tempo: { min: 80, max: 120 },
    },
    chill: {
      moods: ['chill', 'peaceful'],
      energy: { min: 0.1, max: 0.5 },
      tempo: { min: 60, max: 110 },
    },
    romantic: {
      moods: ['romantic', 'dreamy'],
      energy: { min: 0.2, max: 0.6 },
      tempo: { min: 60, max: 110 },
    },
    dark: {
      moods: ['dark', 'melancholic'],
      energy: { min: 0.3, max: 0.7 },
      tempo: { min: 70, max: 130 },
    },
    nostalgic: {
      moods: ['nostalgic', 'dreamy'],
      energy: { min: 0.3, max: 0.6 },
      tempo: { min: 70, max: 120 },
    },
    peaceful: {
      moods: ['peaceful', 'chill'],
      energy: { min: 0.1, max: 0.4 },
      tempo: { min: 50, max: 90 },
    },
  };

  getParamsForMood(moodId: string): MoodParameters {
    const params = this.moodMap[moodId.toLowerCase()];
    if (!params) {
      // Fallback to generic balanced parameters
      return {
        moods: [moodId],
        energy: { min: 0.0, max: 1.0 },
        tempo: { min: 60, max: 180 },
      };
    }
    return params;
  }

  getAllMoods() {
    return Object.keys(this.moodMap).map(id => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
    }));
  }
}
