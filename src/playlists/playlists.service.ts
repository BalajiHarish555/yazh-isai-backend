import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { getJwtSecret } from '../auth/jwt-secret.util';
import { createHmac, timingSafeEqual } from 'crypto';

function editKeyFor(shareId: string): string {
  // Deterministic, unguessable capability token — no extra column needed.
  // Uses the same JWT secret source as auth so it stays in sync.
  const secret = getJwtSecret();
  return createHmac('sha256', secret).update(`shared-playlist:${shareId}`).digest('hex').slice(0, 32);
}

@Injectable()
export class PlaylistsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  private async requireOwner(playlistId: string, userId: string) {
    const pl = await this.prisma.playlist.findUnique({
      where: { id: playlistId },
      select: { ownerId: true },
    });
    if (!pl) throw new NotFoundException('Playlist not found');
    if (pl.ownerId !== userId) throw new ForbiddenException('Not your playlist');
  }

  async create(userId: string, data: { name: string, description?: string, coverImage?: string, isPublic?: boolean }) {
    const name = typeof data?.name === 'string' ? data.name.trim().slice(0, 100) : '';
    if (!name) throw new BadRequestException('Playlist name is required');
    return this.prisma.playlist.create({
      data: {
        name,
        description: typeof data?.description === 'string' ? data.description.slice(0, 500) : undefined,
        coverImage: typeof data?.coverImage === 'string' ? data.coverImage.slice(0, 500) : undefined,
        isPublic: data?.isPublic !== false,
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

  async addTrack(userId: string, playlistId: string, trackId: string, position: number) {
    await this.requireOwner(playlistId, userId);
    if (!trackId || typeof trackId !== 'string') {
      throw new BadRequestException('trackId is required');
    }
    const pos = Number.isFinite(Number(position)) ? Math.max(0, Math.floor(Number(position))) : 0;
    try {
      return await this.prisma.playlistTrack.create({
        data: { playlistId, trackId, position: pos },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictException('Track already in playlist');
      throw err;
    }
  }

  async removeTrack(userId: string, playlistId: string, trackId: string) {
    await this.requireOwner(playlistId, userId);
    const res = await this.prisma.playlistTrack.deleteMany({
      where: { playlistId, trackId },
    });
    return { removed: res.count > 0 };
  }

  async update(id: string, userId: string, data: any) {
    await this.requireOwner(id, userId);
    const patch: any = {};
    if (typeof data?.name === 'string' && data.name.trim()) patch.name = data.name.trim().slice(0, 100);
    if (typeof data?.description === 'string') patch.description = data.description.slice(0, 500);
    if (typeof data?.coverImage === 'string') patch.coverImage = data.coverImage.slice(0, 500);
    if (typeof data?.isPublic === 'boolean') patch.isPublic = data.isPublic;
    if (Object.keys(patch).length === 0) {
      return this.findOne(id, userId);
    }
    return this.prisma.playlist.update({
      where: { id },
      data: patch,
    });
  }

  async delete(id: string, userId: string) {
    await this.requireOwner(id, userId);
    await this.prisma.playlist.delete({
      where: { id },
    });
    return { deleted: true };
  }

  private sanitizeShareTrack(s: any): any | null {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string') return null;
    return {
      id: s.id,
      title: s.title.slice(0, 200),
      artist: typeof s.artist === 'string' ? s.artist.slice(0, 200) : '',
      albumArt: typeof s.albumArt === 'string' ? s.albumArt.slice(0, 500) : '',
      source: typeof s.source === 'string' ? s.source.slice(0, 50) : undefined,
    };
  }

  async publishShare(userId: string, data: any) {
    const tracks = Array.isArray(data?.tracks)
      ? data.tracks.map((t: any) => this.sanitizeShareTrack(t)).filter(Boolean).slice(0, 200)
      : [];
    const share = await this.prisma.sharedPlaylist.create({
      data: {
        ownerId: userId,
        name: typeof data?.name === 'string' && data.name.trim() ? data.name.slice(0, 100) : 'Shared Playlist',
        tracks: JSON.stringify(tracks),
      },
    });
    return {
      id: share.id,
      name: share.name,
      trackCount: tracks.length,
      createdAt: share.createdAt,
      // Hand this edit link to collaborators; view links stay read-only.
      editKey: editKeyFor(share.id),
    };
  }

  async getShare(id: string) {
    const share = await this.prisma.sharedPlaylist.findUnique({
      where: { id },
      include: { owner: { select: { username: true } } },
    });
    if (!share) return null;
    let tracks: any[] = [];
    try {
      const parsed = JSON.parse(share.tracks);
      if (Array.isArray(parsed)) tracks = parsed;
    } catch {
      tracks = [];
    }
    return {
      id: share.id,
      name: share.name,
      owner: (share.owner as any)?.username || 'Someone',
      tracks,
      createdAt: share.createdAt,
    };
  }

  async deleteShare(id: string, userId: string) {
    const share = await this.prisma.sharedPlaylist.findFirst({ where: { id, ownerId: userId } });
    if (!share) return { deleted: false };
    await this.prisma.sharedPlaylist.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Collaborative edit: anyone holding the editKey (owner or invited
   * collaborator) may replace the track list. Verified with a
   * timing-safe comparison; the key itself is never stored.
   */
  async updateSharedTracks(id: string, editKey: string, tracks: any) {
    const expected = editKeyFor(id);
    const a = Buffer.from(typeof editKey === 'string' ? editKey : '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { updated: false, reason: 'invalid edit key' };
    }
    const clean = (Array.isArray(tracks) ? tracks : [])
      .map((t: any) => this.sanitizeShareTrack(t))
      .filter(Boolean)
      .slice(0, 200);
    try {
      await this.prisma.sharedPlaylist.update({
        where: { id },
        data: { tracks: JSON.stringify(clean) },
      });
    } catch {
      return { updated: false, reason: 'Share not found' };
    }
    return { updated: true, trackCount: clean.length };
  }
}
