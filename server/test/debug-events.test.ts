import { describe, expect, it, vi } from 'vitest';
import { DebugEventStore } from '../src/debug-events.js';

describe('DebugEventStore', () => {
  it('keeps only the newest events and respects list limit', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new DebugEventStore(3);
    store.add('info', 'test', 'one');
    store.add('info', 'test', 'two');
    store.add('warn', 'test', 'three');
    store.add('error', 'test', 'four');
    expect(store.list(10).map(event => event.message)).toEqual(['two', 'three', 'four']);
    expect(store.list(2).map(event => event.message)).toEqual(['three', 'four']);
    vi.restoreAllMocks();
  });

  it('clears the event history', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new DebugEventStore();
    store.add('info', 'test', 'event');
    store.clear();
    expect(store.list()).toEqual([]);
    vi.restoreAllMocks();
  });
});
