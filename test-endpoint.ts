import fetch from 'node-fetch';

// Test the lyrics endpoint directly
async function testEndpoint() {
  const baseUrl = 'http://localhost:5000/api/v1/lyrics';
  
  // Test cases
  const testCases = [
    { artist: 'Queen', track: 'Bohemian Rhapsody' },
    { artist: 'The Beatles', track: 'Hey Jude' },
    { artist: 'Michael Jackson', track: 'Billie Jean' }
  ];
  
  console.log('Testing lyrics endpoint...\n');
  
  for (const testCase of testCases) {
    const url = `${baseUrl}?artist=${encodeURIComponent(testCase.artist)}&track=${encodeURIComponent(testCase.track)}`;
    console.log(`Testing: ${testCase.artist} - ${testCase.track}`);
    console.log(`URL: ${url}`);
    
    try {
      const response = await fetch(url);
      const data = await response.json();
      
      if (response.ok && data.lyrics) {
        console.log(`✓ SUCCESS: Found lyrics (${data.lyrics.length} characters)`);
        console.log(`  Preview: "${data.lyrics.substring(0, 100)}..."\n`);
      } else if (response.ok && !data.lyrics && !data.error) {
        console.log(`? RESPONSE: ${JSON.stringify(data)}\n`);
      } else {
        console.log(`✗ FAILED: ${response.status} - ${JSON.stringify(data)}\n`);
      }
    } catch (error) {
      console.log(`✗ ERROR: ${error}\n`);
    }
  }
  
  // Test path parameter endpoint
  console.log('Testing path parameter endpoint...\n');
  try {
    const url = `${baseUrl}/Queen/Bohemian%20Rhapsody`;
    console.log(`Testing: Queen - Bohemian Rhapsody (path params)`);
    console.log(`URL: ${url}`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (response.ok && data.lyrics) {
      console.log(`✓ SUCCESS: Found lyrics (${data.lyrics.length} characters)`);
      console.log(`  Preview: "${data.lyrics.substring(0, 100)}..."\n`);
    } else {
      console.log(`✗ FAILED: ${response.status} - ${JSON.stringify(data)}\n`);
    }
  } catch (error) {
    console.log(`✗ ERROR: ${error}\n`);
  }
}

testEndpoint().catch(console.error);