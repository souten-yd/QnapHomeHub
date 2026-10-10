/** Bounded in-memory limiter: repeated idle BLE logs never hit Docker stdout. */
export type RadioLogLevel = 'info' | 'warn' | 'error';

export class RadioLogLimiter {
  private readonly recent = new Map<string, number>();
  constructor(
    private readonly sink: (level: RadioLogLevel, line: string) => void,
    private readonly clock: () => number = Date.now,
    private readonly suppressForMs = 5 * 60_000,
    private readonly level = process.env.HOMEHUB_RADIO_LOG_LEVEL ?? 'warn',
  ) {}

  write(level: RadioLogLevel, source: string, message: string, details?: Record<string, unknown>): void {
    const severity = { info: 0, warn: 1, error: 2 };
    const minimum = this.level === 'info' || this.level === 'debug' ? 0 : this.level === 'error' ? 2 : 1;
    if (severity[level] < minimum) return;
    // Details can contain identifiers or changing RSSI: exclude them from the dedup key.
    const key = JSON.stringify([level, source, message]);
    const now = this.clock();
    const last = this.recent.get(key);
    if (last !== undefined && now - last < this.suppressForMs) return;
    if (this.recent.size >= 128) {
      for (const [entry, when] of this.recent) if (now - when >= this.suppressForMs) this.recent.delete(entry);
      if (this.recent.size >= 128) this.recent.clear();
    }
    this.recent.set(key, now);
    // Don't leak per-device advertising details into disk-backed Docker logs.
    this.sink(level, JSON.stringify({ level, source, message }));
  }
}
