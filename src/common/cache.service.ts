import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private memoryCache = new Map<string, { value: any; expiresAt: number }>();

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

    try {
      this.redis = new Redis({
        host,
        port,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });

      this.redis.on('error', () => {
        // Fallback silently to in-memory map
        this.redis = null;
      });

      this.redis.connect().catch(() => {
        this.redis = null;
      });
    } catch {
      this.redis = null;
    }
  }

  async set(key: string, value: any, ttl = 3600): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
        return;
      } catch {
        this.redis = null;
      }
    }
    this.memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
      } catch {
        this.redis = null;
      }
    }
    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }
    return item.value as T;
  }

  async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        this.redis = null;
      }
    }
    this.memoryCache.delete(key);
  }
}