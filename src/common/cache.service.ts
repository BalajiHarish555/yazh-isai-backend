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
        // Fallback silently to in-memory map, but keep trying in the
        // background — a Redis restart shouldn't permanently kill caching.
        this.redis = null;
        this.scheduleReconnect(host, port);
      });

      this.redis.connect().catch(() => {
        this.redis = null;
        this.scheduleReconnect(host, port);
      });
    } catch {
      this.redis = null;
    }
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleReconnect(host: string, port: number) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.redis) return;
      try {
        const client = new Redis({
          host,
          port,
          lazyConnect: true,
          enableOfflineQueue: false,
          retryStrategy: () => null,
        });
        client.on('error', () => {
          try {
            client.disconnect();
          } catch {
            // ignore
          }
        });
        client
          .connect()
          .then(() => {
            this.redis = client;
            client.on('error', () => {
              this.redis = null;
              this.scheduleReconnect(host, port);
            });
          })
          .catch(() => {
            this.scheduleReconnect(host, port);
          });
      } catch {
        this.scheduleReconnect(host, port);
      }
    }, 30000);
    const t: any = this.reconnectTimer;
    if (t && typeof t.unref === 'function') t.unref();
  }

  isRedisUp(): boolean {
    return this.redis !== null;
  }

  private static readonly MAX_MEMORY_ENTRIES = 500;

  async set(key: string, value: any, ttl = 3600): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
        return;
      } catch {
        this.redis = null;
      }
    }
    // Bound the in-memory fallback: attacker-controlled keys (search_*,
    // audio_details_*) must not grow it without limit. Evict oldest first
    // (Map preserves insertion order).
    if (!this.memoryCache.has(key)) {
      while (this.memoryCache.size >= CacheService.MAX_MEMORY_ENTRIES) {
        const oldest = this.memoryCache.keys().next();
        if (oldest.done) break;
        this.memoryCache.delete(oldest.value);
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
        if (!data) return null;
        try {
          return JSON.parse(data) as T;
        } catch {
          // One corrupt key must not take down the whole Redis client.
          await this.del(key).catch(() => undefined);
          return null;
        }
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