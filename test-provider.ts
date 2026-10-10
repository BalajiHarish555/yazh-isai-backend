import fetch from 'node-fetch';

interface LyricsOvhResponse {
  lyrics?: string;
  error?: string;
  [key: string]: any;
}

async function testLyricsOvh() {
  const artist = 'Queen';
  const track = 'Bohemian Rhapsody';
  
  console.log(`Testing LyricsOvh for ${artist} - ${track}`);
  
  try {
    const response = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`
    );
    
    console.log(`Response status: ${response.status}`);
    
    if (!response.ok) {
      console.log(`HTTP error! status: ${response.status}`);
      const errorText = await response.text();
      console.log(`Error response: ${errorText.substring(0, 200)}`);
      return;
    }

    const data = await response.json() as LyricsOvhResponse;
    console.log(`Response data:`, JSON.stringify(data, null, 2));
    
    if (data && data.lyrics) {
      console.log(`✓ Found lyrics (${data.lyrics.length} chars)`);
      console.log('First 300 chars:', data.lyrics.substring(0, 300));
    } else {
      console.log('✗ No lyrics found in response');
      if (data.error) {
        console.log(`Error from API: ${data.error}`);
      }
    }
  } catch (error) {
    console.log(`✗ Error: ${error}`);
  }
}

testLyricsOvh();