export interface WindowOccurrence<T> {
  at: number;
  value: T;
}

export interface WindowResult<T> {
  triggered: boolean;
  occurrences: WindowOccurrence<T>[];
}

export class SlidingWindow<T> {
  private readonly buckets = new Map<string, WindowOccurrence<T>[]>();

  add(key: string, value: T, limit: number, windowMs: number, now = Date.now()): WindowResult<T> {
    const cutoff = now - windowMs;
    const recent = (this.buckets.get(key) ?? []).filter((item) => item.at >= cutoff);
    recent.push({ at: now, value });
    this.buckets.set(key, recent);

    return {
      triggered: recent.length >= limit,
      occurrences: [...recent],
    };
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  prune(now = Date.now(), maxAgeMs = 10 * 60_000): void {
    for (const [key, values] of this.buckets) {
      const recent = values.filter((item) => item.at >= now - maxAgeMs);
      if (recent.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, recent);
    }
  }
}
