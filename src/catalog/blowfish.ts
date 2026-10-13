import { BLOWFISH_PI_HEX } from './blowfish-constants';

/**
 * Pure-JS Blowfish (CBC mode, no padding) — self-contained so the server
 * never depends on OpenSSL's legacy provider (Blowfish was removed from
 * OpenSSL 3's default provider; `--openssl-legacy-provider` is fragile on
 * alpine/Render). Used only to decrypt Deezer's BF_CBC_STRIPE audio.
 *
 * The P-array/S-boxes are initialized from the fractional hex digits of pi,
 * per the Blowfish spec (see scripts/gen-blowfish-constants.js).
 */

const ROUNDS = 16;

function initWords(): { P: Uint32Array; S: Uint32Array } {
  const P = new Uint32Array(18);
  const S = new Uint32Array(4 * 256);
  for (let i = 0; i < 18; i++) {
    P[i] = parseInt(BLOWFISH_PI_HEX.slice(i * 8, i * 8 + 8), 16) >>> 0;
  }
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 256; i++) {
      const idx = 18 + b * 256 + i;
      S[b * 256 + i] = parseInt(BLOWFISH_PI_HEX.slice(idx * 8, idx * 8 + 8), 16) >>> 0;
    }
  }
  return { P, S };
}

export class Blowfish {
  private readonly P: Uint32Array;
  private readonly S: Uint32Array;

  constructor(key: Uint8Array) {
    const { P, S } = initWords();
    this.P = P;
    this.S = S;

    // XOR the key into the P-array in 4-byte words, cycling.
    let j = 0;
    for (let i = 0; i < 18; i++) {
      let d = 0;
      for (let k = 0; k < 4; k++) {
        d = ((d << 8) | key[j]) >>> 0;
        j = (j + 1) % key.length;
      }
      this.P[i] = (this.P[i] ^ d) >>> 0;
    }

    // Encrypt an all-zero block 522 times to fill P and S (spec key schedule).
    let l = 0;
    let r = 0;
    for (let i = 0; i < 18; i += 2) {
      [l, r] = this.encryptBlock(l, r);
      this.P[i] = l;
      this.P[i + 1] = r;
    }
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 256; i += 2) {
        [l, r] = this.encryptBlock(l, r);
        this.S[b * 256 + i] = l;
        this.S[b * 256 + i + 1] = r;
      }
    }
  }

  private f(x: number): number {
    const S = this.S;
    const a = S[x >>> 24];
    const b = S[256 + ((x >>> 16) & 0xff)];
    const c = S[512 + ((x >>> 8) & 0xff)];
    const d = S[768 + (x & 0xff)];
    // (S0 + S1) ^ S2 + S3  — all additions mod 2^32.
    return ((((a + b) >>> 0) ^ c) + d) >>> 0;
  }

  /** Encrypt one 64-bit block (two 32-bit words) — used only for key setup. */
  private encryptBlock(l0: number, r0: number): [number, number] {
    let l = l0 >>> 0;
    let r = r0 >>> 0;
    const P = this.P;
    for (let i = 0; i < ROUNDS; i++) {
      l = (l ^ P[i]) >>> 0;
      r = (this.f(l) ^ r) >>> 0;
      const t = l;
      l = r;
      r = t;
    }
    // Undo the final swap, then apply the last two key words (spec order:
    // Xr ^= P[16], Xl ^= P[17]).
    const t = l;
    l = r;
    r = t;
    r = (r ^ P[ROUNDS]) >>> 0;
    l = (l ^ P[ROUNDS + 1]) >>> 0;
    return [l, r];
  }

  /** Decrypt one 64-bit block. */
  private decryptBlock(l0: number, r0: number): [number, number] {
    let l = l0 >>> 0;
    let r = r0 >>> 0;
    const P = this.P;
    for (let i = ROUNDS + 1; i > 1; i--) {
      l = (l ^ P[i]) >>> 0;
      r = (this.f(l) ^ r) >>> 0;
      const t = l;
      l = r;
      r = t;
    }
    // Undo the final swap, then apply P[1], P[0] (mirror of encrypt).
    const t = l;
    l = r;
    r = t;
    r = (r ^ P[1]) >>> 0;
    l = (l ^ P[0]) >>> 0;
    return [l, r];
  }

  /**
   * Decrypt a CBC buffer with a fixed IV and NO padding. Each call is
   * independent (Blowfish block = 8 bytes), so a caller can decrypt any
   * 2048-byte Deezer stripe in isolation — which is exactly what the
   * BF_CBC_STRIPE format requires.
   */
  decryptCbc(data: Uint8Array, iv: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    const prev = new Uint8Array(iv);
    for (let off = 0; off + 8 <= data.length; off += 8) {
      const cipherBlock = data.subarray(off, off + 8);
      // Copy the ciphertext block BEFORE decrypting (we mutate in place below).
      const saved = new Uint8Array(cipherBlock);
      let l =
        ((cipherBlock[0] << 24) |
          (cipherBlock[1] << 16) |
          (cipherBlock[2] << 8) |
          cipherBlock[3]) >>>
        0;
      let r =
        ((cipherBlock[4] << 24) |
          (cipherBlock[5] << 16) |
          (cipherBlock[6] << 8) |
          cipherBlock[7]) >>>
        0;
      [l, r] = this.decryptBlock(l, r);
      out[off] = (l >>> 24) & 0xff;
      out[off + 1] = (l >>> 16) & 0xff;
      out[off + 2] = (l >>> 8) & 0xff;
      out[off + 3] = l & 0xff;
      out[off + 4] = (r >>> 24) & 0xff;
      out[off + 5] = (r >>> 16) & 0xff;
      out[off + 6] = (r >>> 8) & 0xff;
      out[off + 7] = r & 0xff;
      // CBC: XOR plaintext with the previous CIPHERTEXT block.
      for (let k = 0; k < 8; k++) {
        out[off + k] = out[off + k] ^ prev[k];
      }
      prev.set(saved);
    }
    return out;
  }
}

/**
 * Derive Deezer's per-track Blowfish key: md5(trackId) — XOR-folded with the
 * secret "g4el58wc0zvf9na1", exactly as every public Deezer tool does.
 */
export function deezerBlowfishKey(trackId: string, md5Hex: (s: string) => string): Uint8Array {
  const SECRET = 'g4el58wc' + '0zvf9na1';
  const idMd5 = md5Hex(trackId);
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const a = parseInt(idMd5.slice(i * 2, i * 2 + 2), 16);
    const b = parseInt(idMd5.slice(16 + i * 2, 16 + i * 2 + 2), 16);
    key[i] = a ^ b ^ SECRET.charCodeAt(i);
  }
  return key;
}
