import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class TracksService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async findAll(filter: any) {
    const { mood, energyMin, energyMax } = filter;
    
    const tracks = await this.prisma.track.findMany({
      where: {
        energy: {
          gte: energyMin !== undefined ? Number(energyMin) : 0,
          lte: energyMax !== undefined ? Number(energyMax) : 1,
        },
      },
      include: { artists: { include: { artist: true } } },
    });

    if (mood) {
      return tracks.filter((t: any) => {
        const moods = Array.isArray(t.mood) ? t.mood : (typeof t.mood === 'string' ? JSON.parse(t.mood || '[]') : []);
        return moods.includes(mood);
      });
    }

    return tracks;
  }

  async findOne(id: string) {
    return this.prisma.track.findUnique({
      where: { id },
      include: { artists: { include: { artist: true } } },
    });
  }

  async create(data: any) {
    return this.prisma.track.create({ data });
  }
}
