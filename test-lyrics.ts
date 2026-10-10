import { LyricsService } from './src/lyrics/lyrics.service';
import { CacheService } from './src/common/cache.service';

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

// Test the lyrics service
async function testLyricsService() {
  const cacheService = new MockCacheService();
  const lyricsService = new LyricsService(cacheService);
  
  // Test with a known song that should have lyrics
  const testCases = [
    { artist: 'Queen', track: 'Bohemian Rhapsody' },
    { artist: 'The Beatles', track: 'Hey Jude' },
    { artist: 'Michael Jackson', track: 'Billie Jean' },
    { artist: 'Ed Sheeran', track: 'Shape of You' },
    { artist: 'ArtistThatDoesNotExist12345', track: 'SongThatDoesNotExist12345' }
  ];
  
  console.log('Testing lyrics service...\n');
  
  for (const testCase of testCases) {
    console.log(`Searching for: ${testCase.artist} - ${testCase.track}`);
    try {
      const lyrics = await lyricsService.getLyrics(testCase.artist, testCase.track);
      if (lyrics) {
        console.log(`✓ Found lyrics (${lyrics.length} chars):\n${lyrics.substring(0, 200)}...\n`);
      } else {
        console.log('✗ No lyrics found\n');
      }
    } catch (error) {
      console.log(`✗ Error: ${error}\n`);
    }
  }
}

testLyricsService().catch(console.error);