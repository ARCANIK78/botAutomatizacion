import { Injectable } from '@nestjs/common';

@Injectable()
export class IdempotencyCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs = 5 * 60 * 1000;
  private readonly maxEntries = 1000;

  has(key: string): boolean {
    this.prune();
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string): void {
    this.prune();
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, Date.now() + this.ttlMs);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expires] of this.entries) {
      if (expires < now) this.entries.delete(key);
    }
  }
}
