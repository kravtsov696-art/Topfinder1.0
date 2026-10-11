import { createHash, randomBytes, randomInt, timingSafeEqual, randomUUID } from 'node:crypto';
import { INVITE_POLICY } from '../../../packages/shared/src/index.ts';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
export function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}
export function uuid(): string {
  return randomUUID();
}
export function newInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_POLICY.codeLength; i++) out += INVITE_POLICY.alphabet[randomInt(INVITE_POLICY.alphabet.length)];
  return out;
}
export function safeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

// Удаляем всё, что похоже на координаты, из диагностических данных:
// журналы не должны становиться второй (неучтённой) историей перемещений.
const COORD_KEYS = /^(lat|lon|lng|latitude|longitude|coords|coordinate|coordinates|location|position)$/i;
export function stripCoordinates(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => stripCoordinates(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (COORD_KEYS.test(k)) continue;
      out[k] = stripCoordinates(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') return v.slice(0, 500);
  return v;
}

/** Простое окно ограничения частоты в памяти (P0: один экземпляр сервера). */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  limit: number;
  windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  /** true — можно; false — превышено */
  hit(key: string, now: number, weight = 1): boolean {
    const e = this.hits.get(key);
    if (!e || now - e.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: weight });
      return weight <= this.limit;
    }
    e.count += weight;
    return e.count <= this.limit;
  }
  count(key: string, now: number): number {
    const e = this.hits.get(key);
    if (!e || now - e.windowStart >= this.windowMs) return 0;
    return e.count;
  }
  gc(now: number): void {
    for (const [k, e] of this.hits) if (now - e.windowStart >= this.windowMs) this.hits.delete(k);
  }
}
