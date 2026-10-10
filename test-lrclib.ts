import fetch from 'node-fetch';

interface LrcLibTrack {
  plainLyrics?: string;
  lyrics?: string;
  [key: string]: any;
}

interface LrcLibResponse extends Array<LrcLibTrack> {}

async function testLrcLib() {
  const artist = 'Queen';
  const track = 'Bohemian Rhapsody';
  
  console.log(`Testing LrcLib for ${artist} - ${track}`);
  
  try {
    const response = await fetch(
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`
    );
    
    console.log(`Response status: ${response.status}`);
    
    if (!response.ok) {
      console.log(`HTTP error! status: ${response.status}`);
      return;
    }

    const data = await response.json() as LrcLibResponse;
    console.log(`Received ${data.length} results`);
    
    if (Array.isArray(data) && data.length > 0) {
      const lyrics = data[0].plainLyrics || data[0].lyrics;
      if (lyrics) {
        console.log(`✓ Found lyrics (${lyrics.length} chars)`);
        console.log('First 300 chars:', lyrics.substring(0, 300));
      } else {
        console.log('✗ No lyrics found in result');
        console.log('First result:', JSON.stringify(data[0], null, 2));
      }
    } else {
      console.log('✗ No results found');
    }
  } catch (error) {
    console.log(`✗ Error: ${error}`);
  }
}

testLrcLib();