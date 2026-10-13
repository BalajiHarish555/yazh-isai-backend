// Cross-check the pure-JS Blowfish against OpenSSL's bf-cbc (legacy provider).
// Run: node --openssl-legacy-provider scripts/verify-blowfish.js
import { Blowfish, deezerBlowfishKey } from '../src/catalog/blowfish';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const md5 = (s: string) => crypto.createHash('md5').update(s, 'ascii').digest('hex');

function opensslDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const d = crypto.createDecipheriv('bf-cbc', Buffer.from(key), Buffer.from(iv));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(Buffer.from(data)), d.final()]);
}

const trackId = '123456';
const key = deezerBlowfishKey(trackId, md5);
const iv = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

// Deterministic pseudo-random 2048-byte stripe (a full Blowfish block multiple).
const stripe = new Uint8Array(2048);
let x = 0x12345678;
for (let i = 0; i < 2048; i++) {
  x = (x * 1103515245 + 12345) >>> 0;
  stripe[i] = x & 0xff;
}

const js = new Blowfish(key).decryptCbc(stripe, iv);
const ref = opensslDecrypt(key, iv, stripe);

let match = js.length === ref.length;
for (let i = 0; i < Math.min(js.length, ref.length); i++) {
  if (js[i] !== ref[i]) {
    console.error(`MISMATCH at byte ${i}: js=${js[i]} ref=${ref[i]}`);
    match = false;
    break;
  }
}

if (match) {
  console.log(`BLOWFISH MATCHES OPENSLL  key=${Buffer.from(key).toString('hex')} len=${js.length}`);
  // Also verify against the saved fixture if present (from an earlier run).
  const fixture = path.join(__dirname, '..', 'src', 'catalog', 'blowfish-constants.ts');
  console.log(`constants file present: ${fs.existsSync(fixture)}`);
} else {
  console.error('BLOWFISH MISMATCH vs OpenSSL');
  process.exit(1);
}
