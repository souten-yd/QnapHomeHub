export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEvent {
  seq: number;
  at: string;
  level: DebugLevel;
  source: string;
  message: string;
  details?: Record<string, unknown>;
}

export class DebugEventStore {
  private readonly events: DebugEvent[] = [];
  private seq = 0;

  constructor(private readonly maxEvents = 250) {}

  add(level: DebugLevel, source: string, message: string, details?: Record<string, unknown>): DebugEvent {
    const event: DebugEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level,
      source,
      message,
      ...(details ? { details } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);

    const prefix = `[HomeHub:${source}] ${message}`;
    if (level === 'error') console.error(prefix, details ?? '');
    else if (level === 'warn') console.warn(prefix, details ?? '');
    else console.log(prefix, details ?? '');
    return event;
  }

  list(limit = 100): DebugEvent[] {
    const safeLimit = Math.min(this.maxEvents, Math.max(1, Math.trunc(limit || 100)));
    return this.events.slice(-safeLimit);
  }

  clear(): void {
    this.events.length = 0;
  }
}
