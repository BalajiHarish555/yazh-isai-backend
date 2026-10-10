import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';

const PROFILE_FIELDS = [
  'displayName',
  'avatarUrl',
  'bio',
  'country',
  'preferredLanguage',
] as const;

@Injectable()
export class ProfilesService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
        profile: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [likedTracks, likedAlbums, playlists, followedArtists, totalPlays] =
      await Promise.all([
        this.prisma.likedTrack.count({ where: { userId } }),
        this.prisma.likedAlbum.count({ where: { userId } }),
        this.prisma.playlist.count({ where: { ownerId: userId } }),
        this.prisma.followedArtist.count({ where: { userId } }),
        this.prisma.listeningEvent.count({ where: { userId } }),
      ]);

    return {
      ...user,
      memberSince: user.createdAt,
      stats: { likedTracks, likedAlbums, playlists, followedArtists, totalPlays },
    };
  }

  async updateProfile(userId: string, dto: any) {
    const data: Record<string, string> = {};
    for (const field of PROFILE_FIELDS) {
      if (typeof dto?.[field] === 'string') {
        data[field] = dto[field].slice(0, 500);
      }
    }
    return this.prisma.profile.upsert({
      where: { userId },
      update: data,
      create: { userId, displayName: data.displayName || 'Music Fan', ...data },
    });
  }

  private parseLibrary(raw: string | null): { liked: any[]; playlists: any[] } {
    if (!raw) return { liked: [], playlists: [] };
    try {
      const parsed = JSON.parse(raw);
      return {
        liked: Array.isArray(parsed?.liked) ? parsed.liked : [],
        playlists: Array.isArray(parsed?.playlists) ? parsed.playlists : [],
      };
    } catch {
      return { liked: [], playlists: [] };
    }
  }

  private sanitizeSong(s: any): any | null {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string') return null;
    return {
      id: s.id,
      title: s.title.slice(0, 200),
      artist: typeof s.artist === 'string' ? s.artist.slice(0, 200) : '',
      album: typeof s.album === 'string' ? s.album.slice(0, 200) : undefined,
      albumArt: typeof s.albumArt === 'string' ? s.albumArt.slice(0, 500) : '',
      streamUrl: typeof s.streamUrl === 'string' ? s.streamUrl.slice(0, 1000) : undefined,
      source: typeof s.source === 'string' ? s.source.slice(0, 50) : undefined,
      duration: typeof s.duration === 'number' ? s.duration : undefined,
    };
  }

  /**
   * Cross-device library sync. The client sends its full local state; the
   * server unions it with what's stored (dedupe by song/playlist id, sane
   * caps) and returns the merged result both sides converge on.
   */
  async syncLibrary(userId: string, dto: any) {
    const incoming = this.parseLibrary(
      typeof dto?.library === 'string' ? dto.library : JSON.stringify(dto || {}),
    );

    const stored = await this.prisma.profile.findUnique({
      where: { userId },
      select: { library: true },
    });
    const current = this.parseLibrary(stored?.library || null);

    const mergeSongs = (a: any[], b: any[]) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const s of [...a, ...b]) {
        const clean = this.sanitizeSong(s);
        if (clean && !seen.has(clean.id)) {
          seen.add(clean.id);
          out.push(clean);
        }
        if (out.length >= 500) break;
      }
      return out;
    };

    const seenPlaylists = new Set<string>();
    const playlists: any[] = [];
    for (const p of [...current.playlists, ...incoming.playlists]) {
      const id = typeof p?.id === 'string' ? p.id : '';
      if (!id || seenPlaylists.has(id)) continue;
      seenPlaylists.add(id);
      playlists.push({
        id,
        name: typeof p?.name === 'string' ? p.name.slice(0, 100) : 'Untitled Playlist',
        tracks: mergeSongs(p?.tracks || [], []),
        createdAt: typeof p?.createdAt === 'number' ? p.createdAt : Date.now(),
      });
      if (playlists.length >= 50) break;
    }

    const merged = { liked: mergeSongs(current.liked, incoming.liked), playlists };
    await this.prisma.profile.upsert({
      where: { userId },
      update: { library: JSON.stringify(merged) },
      create: { userId, displayName: 'Music Fan', library: JSON.stringify(merged) },
    });
    return merged;
  }

  async getLibrary(userId: string) {
    const stored = await this.prisma.profile.findUnique({
      where: { userId },
      select: { library: true },
    });
    return this.parseLibrary(stored?.library || null);
  }

  async getHistory(userId: string, limit: string | number = 20) {
    const take = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.prisma.listeningEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      include: { track: { include: { artists: { include: { artist: true } } } } },
    });
  }

  async recordPlay(userId: string, dto: any) {
    const trackId = typeof dto?.trackId === 'string' ? dto.trackId : '';
    if (!trackId) return { recorded: false, reason: 'trackId is required' };

    // ListeningEvent.trackId is a FK to the catalog Track table, so
    // external ids (e.g. YouTube video ids) cannot be recorded — skip them
    // instead of crashing on a constraint violation.
    const track = await this.prisma.track.findUnique({ where: { id: trackId } });
    if (!track) return { recorded: false, reason: 'track is not in the local catalog' };

    const event = await this.prisma.listeningEvent.create({
      data: {
        userId,
        trackId,
        position: Number(dto?.position) || 0,
        duration: Number(dto?.duration) || 0,
        completed: dto?.completed === true,
        eventType: typeof dto?.eventType === 'string' ? dto.eventType.slice(0, 50) : 'play',
      },
    });
    return { recorded: true, event };
  }
}
