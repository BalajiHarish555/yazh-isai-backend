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

async function finalTest() {
  console.log('=== FINAL LYRICS SERVICE TEST ===\n');
  
  const cacheService = new MockCacheService();
  const lyricsService = new LyricsService(cacheService);
  
  // Test cases
  const testCases = [
    { artist: 'Queen', track: 'Bohemian Rhapsody' },
    { artist: 'The Beatles', track: 'Hey Jude' },
    { artist: 'Michael Jackson', track: 'Billie Jean' },
    { artist: 'Ed Sheeran', track: 'Shape of You' },
    { artist: 'ArtistThatDoesNotExist12345', track: 'SongThatDoesNotExist12345' }
  ];
  
  let successCount = 0;
  
  for (const testCase of testCases) {
    console.log(`Testing: ${testCase.artist} - ${testCase.track}`);
    try {
      const lyrics = await lyricsService.getLyrics(testCase.artist, testCase.track);
      if (lyrics && lyrics.length > 0) {
        console.log(`  ✓ SUCCESS: Found lyrics (${lyrics.length} characters)`);
        // Show first 100 characters as preview
        const preview = lyrics.length > 100 ? lyrics.substring(0, 100) + '...' : lyrics;
        console.log(`    Preview: "${preview}"`);
        successCount++;
      } else {
        console.log(`  ✗ FAILURE: No lyrics found`);
      }
  } catch (error) {
    console.log(`  ✗ ERROR: ${(error as Error).message || error}`);
  }
    console.log('');
  }
  
  console.log(`=== RESULTS ===`);
  console.log(`Successful lookups: ${successCount}/${testCases.length}`);
  console.log(`Success rate: ${Math.round((successCount / testCases.length) * 100)}%`);
  
  if (successCount > 0) {
    console.log(`\n✅ Lyrics service is working correctly!`);
  } else {
    console.log(`\n❌ Lyrics service is not finding any lyrics.`);
  }
}

finalTest().catch(error => {
  console.error('Test failed with error:', error);
  process.exit(1);
});