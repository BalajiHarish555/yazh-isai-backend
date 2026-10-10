import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

@Injectable()
export class LibraryService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async likeTrack(userId: string, trackId: string) {
    return this.prisma.likedTrack.upsert({
      where: { userId_trackId: { userId, trackId } },
      update: {},
      create: { userId, trackId },
    });
  }

  async unlikeTrack(userId: string, trackId: string) {
    return this.prisma.likedTrack.delete({
      where: { userId_trackId: { userId, trackId } },
    });
  }

  async getLikedTracks(userId: string) {
    const liked = await this.prisma.likedTrack.findMany({
      where: { userId },
      include: { track: { include: { artists: { include: { artist: true } } } } },
    });
    return liked.map((lt: any) => lt.track);
  }

  async followArtist(userId: string, artistId: string) {
    return this.prisma.followedArtist.upsert({
      where: { userId_artistId: { userId, artistId } },
      update: {},
      create: { userId, artistId },
    });
  }

  async unfollowArtist(userId: string, artistId: string) {
    return this.prisma.followedArtist.delete({
      where: { userId_artistId: { userId, artistId } },
    });
  }

  async getFollowedArtists(userId: string) {
    const followed = await this.prisma.followedArtist.findMany({
      where: { userId },
      include: { artist: true },
    });
    return followed.map((fa: any) => fa.artist);
  }
}
