import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

function safeMoods(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.filter((m): m is string => typeof m === 'string');
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
    }
  } catch {
    // Corrupt row — treat as unmoodable rather than 500ing the listing.
  }
  return [];
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

@Injectable()
export class TracksService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async findAll(filter: any) {
    const { mood, energyMin, energyMax } = filter || {};

    const tracks = await this.prisma.track.findMany({
      where: {
        energy: {
          gte: energyMin !== undefined ? finiteOr(energyMin, 0) : 0,
          lte: energyMax !== undefined ? finiteOr(energyMax, 1) : 1,
        },
      },
      include: { artists: { include: { artist: true } } },
    });

    if (mood) {
      return tracks.filter((t: any) => safeMoods(t.mood).includes(mood));
    }

    return tracks;
  }

  async findOne(id: string) {
    const track = await this.prisma.track.findUnique({
      where: { id },
      include: { artists: { include: { artist: true } } },
    });
    if (!track) throw new NotFoundException('Track not found');
    return track;
  }

  async create(data: any) {
    const title = typeof data?.title === 'string' ? data.title.trim().slice(0, 200) : '';
    if (!title) throw new BadRequestException('Track title is required');
    const duration = Number.isFinite(Number(data?.duration)) ? Math.max(0, Math.floor(Number(data.duration))) : 0;
    return this.prisma.track.create({
      data: {
        title,
        duration,
        albumId: typeof data?.albumId === 'string' ? data.albumId : undefined,
        trackNumber: Number.isFinite(Number(data?.trackNumber)) ? Math.floor(Number(data.trackNumber)) : undefined,
        artworkUrl: typeof data?.artworkUrl === 'string' ? data.artworkUrl.slice(0, 500) : undefined,
        genre: typeof data?.genre === 'string' ? data.genre.slice(0, 100) : undefined,
        language: typeof data?.language === 'string' ? data.language.slice(0, 50) : undefined,
        mood: typeof data?.mood === 'string' ? data.mood.slice(0, 100) : 'chill',
      },
    });
  }
}
