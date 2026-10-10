/** Memory-only rate limiter for routine radio diagnostics.
 *  Docker may persist stdout/stderr to HDD. On a quiet NAS we retain
 *  meaningful warnings/errors but never stream 2-second heartbeat noise.
 */
export type RadioLogLevel = 'info' | 'warn' | 'error';

export class RadioLogLimiter {
  private last = new Map<string, number>();
  private readonly dedupWindowMs: number;
  constructor(
    private readonly sink: (level: RadioLogLevel, line: string) => void,
    private readonly clock: () => number = Date.now,
    dedupWindowMs = 5 * 60_000,
    private readonly configuredLevel = process.env.HOMEHUB_RADIO_LOG_LEVEL || 'warn',
  ) {
    this.dedupWindowMs = dedupWindowMs;
  }

  write(level: RadioLogLevel, source: string, message: string): void {
    const minimum = ({ info: 0, warn: 1, error: 2 } as const)[
      this.configuredLevel === 'debug' || this.configuredLevel === 'info' ? 'info'
        : this.configuredLevel === 'error' ? 'error' : 'warn'
    ];
    if (({ info: 0, warn: 1, error: 2 } as const)[level] < minimum) return;
    // Bound both log emission and memory use, without touching the HDD.
    const key = JSON.stringify([level, source, message]);
    const now = this.clock();
    const last = this.last.get(key);
    if (last !== undefined && now - last < this.dedupWindowMs) return;
    if (this.last.size > 128) {
      for (const [storedKey, at] of this.last)
        if (now - at >= this.dedupWindowMs) this.last.delete(storedKey);
      if (this.last.size > 128) this.last.clear();
    }
    this.last.set(key, now);
    this.sink(level, JSON.stringify({ level, source, message }));
  }
}
