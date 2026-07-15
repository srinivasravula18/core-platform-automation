/**
 * Deterministic PRNG for the Test Data Engine. Seeded from a run-stable string (the mission scope) so a
 * given run always generates the SAME identity/values — reproducible, debuggable, and consistent across
 * every field and case in the run. No Math.random (which would break determinism and reproducibility).
 */
import { createHash } from 'crypto';

/** Hash any string to a 32-bit seed. */
function hashSeed(seed: string): number {
  const hex = createHash('sha1').update(String(seed || 'testflow')).digest('hex').slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

/** mulberry32 — small, fast, well-distributed deterministic generator. */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = hashSeed(seed) || 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick one element deterministically. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] ?? items[0];
  }

  /** A string of `len` digits. */
  digits(len: number): string {
    let out = '';
    for (let i = 0; i < len; i += 1) out += String(this.int(0, 9));
    return out;
  }

  /** `len` chars from an alphabet (default upper alphanumerics, no ambiguous 0/O/1/I). */
  alnum(len: number, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
    let out = '';
    for (let i = 0; i < len; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}
