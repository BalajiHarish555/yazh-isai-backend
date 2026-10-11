import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class ArtistsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async findAll() {
    return this.prisma.artist.findMany({
      orderBy: { name: 'asc' },
      take: 100,
      include: { _count: { select: { albums: true, tracks: true } } },
    });
  }

  async findOne(id: string) {
    const artist = await this.prisma.artist.findUnique({
      where: { id },
      include: { albums: true, tracks: { select: { track: true } } },
    });
    if (!artist) throw new NotFoundException('Artist not found');
    return artist;
  }

  async create(data: any) {
    const name = typeof data?.name === 'string' ? data.name.trim().slice(0, 200) : '';
    if (!name) throw new BadRequestException('Artist name is required');
    return this.prisma.artist.create({
      data: {
        name,
        bio: typeof data?.bio === 'string' ? data.bio.slice(0, 2000) : undefined,
        imageUrl: typeof data?.imageUrl === 'string' ? data.imageUrl.slice(0, 500) : undefined,
        genres: typeof data?.genres === 'string' ? data.genres.slice(0, 500) : JSON.stringify([]),
      },
    });
  }
}
