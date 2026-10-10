import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class ArtistsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async findAll() {
    return this.prisma.artist.findMany({
      include: { _count: { select: { albums: true, tracks: true } } },
    });
  }

  async findOne(id: string) {
    return this.prisma.artist.findUnique({
      where: { id },
      include: { albums: true, tracks: { select: { track: true } } },
    });
  }

  async create(data: any) {
    return this.prisma.artist.create({ data });
  }
}
