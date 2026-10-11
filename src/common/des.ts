/**
 * Minimal DES-ECB decryptor (single purpose: JioSaavn media-URL decryption).
 * Replaces the node-forge dependency, which carried an unfixable HIGH audit
 * advisory. Standard FIPS tables; correctness is pinned by known-answer
 * tests, not by review — see the jiosaavn spec.
 */

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const S: number[][] = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29,
  21, 13, 5, 28, 4, 12, 20,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const ROT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

function permute(bits: number[], table: number[]): number[] {
  const out = new Array<number>(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
  return out;
}

function rotl28(half: number[], n: number): number[] {
  return half.slice(n).concat(half.slice(0, n));
}

function keySchedule(keyBits: number[]): number[][] {
  const pc = permute(keyBits, PC1);
  let c = pc.slice(0, 28);
  let d = pc.slice(28);
  const subs: number[][] = [];
  for (let i = 0; i < 16; i++) {
    c = rotl28(c, ROT[i]);
    d = rotl28(d, ROT[i]);
    subs.push(permute(c.concat(d), PC2));
  }
  return subs;
}

function feistel(r: number[], k: number[]): number[] {
  const x = permute(r, E).map((b, i) => b ^ k[i]);
  const out: number[] = [];
  for (let s = 0; s < 8; s++) {
    const chunk = x.slice(s * 6, s * 6 + 6);
    const row = chunk[0] * 2 + chunk[5];
    const col = chunk[1] * 8 + chunk[2] * 4 + chunk[3] * 2 + chunk[4];
    const v = S[s][row * 16 + col];
    out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permute(out, P);
}

function bytesToBits(bytes: ArrayLike<number>): number[] {
  const bits: number[] = new Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  }
  return bits;
}

function bitsToBytes(bits: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
    out.push(v);
  }
  return out;
}

function decryptBlock(keyBits: number[], subkeys: number[][], block: number[]): number[] {
  const data = permute(bytesToBits(block), IP);
  let l = data.slice(0, 32);
  let r = data.slice(32);
  for (let i = 0; i < 16; i++) {
    const nextL = r;
    const f = feistel(r, subkeys[i]);
    const nextR = l.map((b, j) => b ^ f[j]);
    l = nextL;
    r = nextR;
  }
  return bitsToBytes(permute(r.concat(l), FP));
}

/**
 * DES-ECB decrypt with PKCS#7 unpadding.
 * @param keyBytes 8-byte key
 * @param data ciphertext (length should be a multiple of 8)
 */
export function desEcbDecrypt(keyBytes: ArrayLike<number>, data: ArrayLike<number>): Uint8Array {
  const keyBits = bytesToBits(Array.from(keyBytes));
  const subkeys = keySchedule(keyBits).reverse();
  const out: number[] = [];
  const fullBlocks = Math.floor(data.length / 8);
  for (let o = 0; o < fullBlocks; o++) {
    const block: number[] = [];
    for (let i = 0; i < 8; i++) block.push(data[o * 8 + i]);
    out.push(...decryptBlock(keyBits, subkeys, block));
  }
  // PKCS#7 unpad (validated: all padding bytes must agree).
  const pad = out.length > 0 ? out[out.length - 1] : 0;
  if (pad >= 1 && pad <= 8 && out.length >= pad) {
    let valid = true;
    for (let i = out.length - pad; i < out.length; i++) {
      if (out[i] !== pad) {
        valid = false;
        break;
      }
    }
    if (valid) return Uint8Array.from(out.slice(0, out.length - pad));
  }
  return Uint8Array.from(out);
}

export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
