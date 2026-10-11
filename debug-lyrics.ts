import { LyricsService } from './src/lyrics/lyrics.service';
import { CacheService } from './src/common/cache.service';
import { KuGouLyricsProvider } from './src/lyrics/providers/kugou.provider';
import { LrcLibLyricsProvider } from './src/lyrics/providers/lrclib.provider';
import { LyricsOvhLyricsProvider } from './src/lyrics/providers/lyricsovh.provider';

// Mock cache service for testing
class MockCacheService extends CacheService {
  private cache: Map<string, { value: any; expiry: number }> = new Map();
  
  async get<T>(key: string): Promise<T | null> {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.value as T;
  }
  
  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    const expiry = Date.now() + (ttl * 1000);
    this.cache.set(key, { value, expiry });
  }
  
  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }
}

// Create a debug version by copying the logic with extra logging
async function debugLyricsService() {
  const cacheService = new MockCacheService();
  
  // Initialize providers in order of preference (same as in LyricsService)
  const providers = [
    new KuGouLyricsProvider(),
    new LrcLibLyricsProvider(),
    new LyricsOvhLyricsProvider(),
  ];
  
  // Test with a known song that should have lyrics
  const testCases = [
    { artist: 'Queen', track: 'Bohemian Rhapsody' },
    { artist: 'The Beatles', track: 'Hey Jude' }
  ];
  
  console.log('=== DEBUGGING LYRICS SERVICE ===\n');
  
  for (const testCase of testCases) {
    console.log(`\n--- Testing: ${testCase.artist} - ${testCase.track} ---`);
    const startTime = Date.now();
    const cacheKey = `lyrics_${testCase.artist.toLowerCase()}_${testCase.track.toLowerCase()}`;
    
    console.log(`[DEBUG] Checking cache for key: ${cacheKey}`);
    
    // Try to get from cache first
    const cachedLyrics = await cacheService.get<string>(cacheKey);
    if (cachedLyrics) {
      console.log(`[DEBUG] Cache hit for lyrics: ${testCase.artist} - ${testCase.track}`);
      console.log(`\n✓ SUCCESS: Found lyrics in cache (${cachedLyrics.length} chars)`);
      console.log(`First 200 chars: ${cachedLyrics.substring(0, 200)}`);
      continue;
    }
    
    console.log(`[DEBUG] No cache hit, fetching lyrics for: ${testCase.artist} - ${testCase.track}`);
    
    // Try each provider in order until we find lyrics
    let lyricsFound = null;
    for (const provider of providers) {
      try {
        console.log(`[DEBUG] Checking availability for provider: ${provider.constructor.name}`);
        // Check if provider is available
        const isAvailable = await provider.isAvailable();
        console.log(`[DEBUG] Provider ${provider.constructor.name} available: ${isAvailable}`);
        
        if (!isAvailable) {
          console.log(`[DEBUG] Provider ${provider.constructor.name} is not available, skipping`);
          continue;
        }
        
        console.log(`[DEBUG] Trying provider: ${provider.constructor.name}`);
        const fetchStart = Date.now();
        const lyrics = await provider.fetchLyrics(testCase.artist, testCase.track);
        const fetchDuration = Date.now() - fetchStart;
        console.log(`[DEBUG] Provider ${provider.constructor.name} took ${fetchDuration}ms, returned: ${lyrics ? 'lyrics found' : 'null'}`);
        
        if (lyrics) {
          // Cache the lyrics for 1 day (86400 seconds)
          console.log(`[DEBUG] Caching lyrics from ${provider.constructor.name}`);
          await cacheService.set(cacheKey, lyrics, 86400);
          
          console.log(`[DEBUG] Lyrics fetched and cached from ${provider.constructor.name} for ${testCase.artist} - ${testCase.track} (took ${Date.now() - startTime}ms)`);
          lyricsFound = lyrics;
          break;
        }
      } catch (error) {
        console.log(`[DEBUG] Error fetching lyrics from ${provider.constructor.name} for ${testCase.artist} - ${testCase.track}:`, error);
        // Continue to next provider
      }
    }
    
    if (lyricsFound) {
      console.log(`\n✓ SUCCESS: Found lyrics (${lyricsFound.length} chars)`);
      console.log(`First 200 chars: ${lyricsFound.substring(0, 200)}`);
    } else {
      console.log(`\n✗ FAILURE: No lyrics found from any provider`);
    }
    console.log('-'.repeat(50));
  }
}

debugLyricsService().catch(console.error);