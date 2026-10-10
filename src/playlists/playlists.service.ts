import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class PlaylistsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async create(userId: string, data: { name: string, description?: string, coverImage?: string, isPublic?: boolean }) {
    return this.prisma.playlist.create({
      data: {
        ...data,
        ownerId: userId,
      },
    });
  }

  async findAll(userId: string) {
    return this.prisma.playlist.findMany({
      where: { ownerId: userId },
      include: { _count: { select: { tracks: true } } },
    });
  }

  async findOne(id: string, userId: string) {
    return this.prisma.playlist.findFirst({
      where: { id, ownerId: userId },
      include: { tracks: { include: { track: { include: { artists: { include: { artist: true } } } } } } },
    });
  }

  async addTrack(playlistId: string, trackId: string, position: number) {
    return this.prisma.playlistTrack.create({
      data: { playlistId, trackId, position },
    });
  }

  async removeTrack(playlistId: string, trackId: string) {
    return this.prisma.playlistTrack.delete({
      where: { playlistId_trackId: { playlistId, trackId } },
    });
  }

  async update(id: string, userId: string, data: any) {
    return this.prisma.playlist.update({
      where: { id },
      data,
    });
  }

  async delete(id: string, userId: string) {
    return this.prisma.playlist.delete({
      where: { id },
    });
  }
}
