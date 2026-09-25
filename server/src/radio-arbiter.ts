import { SerialQueue } from './queue.js';

export interface RadioDrivers {
  stopHomeHub(): Promise<void>;
  stopBlueZ(): Promise<void>;
  resumeSelfCare?(): Promise<void>;
  homeHub<T>(request: unknown): Promise<T>;
  selfCare<T>(request: unknown): Promise<T>;
}

/** The next owner cannot run until the previous owner's process has exited. */
export class RadioArbiter {
  private readonly queue = new SerialQueue();
  private pending = 0;
  private active: 'idle' | 'homehub' | 'selfcare' = 'idle';
  constructor(private readonly drivers: RadioDrivers) {}

  status() { return { active: this.active, pending: this.pending }; }

  run<T>(owner: 'homehub' | 'selfcare', request: unknown): Promise<T> {
    if (this.pending >= 8) return Promise.reject(new Error('Bluetooth queue is full; try again shortly'));
    this.pending++;
    const enqueued = Date.now();
    return this.queue.run(async () => {
      this.active = owner;
      try {
        if (Date.now() - enqueued > 60000) throw new Error('Bluetooth request expired in queue; no operation was executed');
        if (owner === 'homehub') {
          await this.drivers.stopBlueZ();
          try { return await this.drivers.homeHub<T>(request); }
          finally {
            await this.drivers.stopHomeHub();
            await this.drivers.resumeSelfCare?.();
          }
        }
        await this.drivers.stopHomeHub();
        return await this.drivers.selfCare<T>(request);
      } finally { this.pending--; this.active = 'idle'; }
    });
  }
}
