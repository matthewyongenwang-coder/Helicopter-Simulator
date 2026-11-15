/** Integer hashing and seed helpers shared by all world generation. */

/** 32-bit avalanche hash of two integers and a seed. */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Uniform float in [0, 1) from two integers and a seed. */
export function rand2(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Small deterministic generator: mulberry32. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for a new launch. */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Math.random() * 4294967296) >>> 0;
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

/** Seeds are shown as seven easy-to-read characters, e.g. "K7M2-QX9". */
export function seedToString(seed: number): string {
  let s = seed >>> 0, out = '';
  for (let i = 0; i < 7; i++) {
    out = ALPHABET[s % 32] + out;
    s = Math.floor(s / 32);
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

/** Parse a displayed seed, a plain number, or hash any other text into a seed. */
export function seedFromString(text: string): number {
  const t = text.trim().toUpperCase().replace(/-/g, '');
  if (/^[0-9]+$/.test(t) && t.length !== 7) return Number(t) >>> 0;
  if (t.length === 7 && [...t].every((c) => ALPHABET.includes(c))) {
    let s = 0;
    for (const c of t) s = s * 32 + ALPHABET.indexOf(c);
    return s >>> 0;
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
