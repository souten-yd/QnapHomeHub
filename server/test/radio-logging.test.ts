import { describe, expect, it, vi } from 'vitest';
import { RadioLogLimiter } from '../src/radio-logging.js';

describe('Shared-radio low-disk-I/O diagnostic policy', () => {
  it('suppresses frequent info traces and duplicate warnings without disk output', () => {
    const sink = vi.fn();
    let now = 0;
    const limiter = new RadioLogLimiter(sink, () => now, 300000, 'warn');
    for (let n = 0; n < 120; n++) {
      limiter.write('info', 'radio', 'USB Bluetooth ownership transferred to SelfCare');
      limiter.write('warn', 'radio', 'Watch temporarily unavailable');
    }
    expect(sink).toHaveBeenCalledOnce();
    now = 300001;
    limiter.write('warn', 'radio', 'Watch temporarily unavailable');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('preserves distinct errors immediately, with repeated errors rate-limited', () => {
    const sink = vi.fn();
    const limiter = new RadioLogLimiter(sink, () => 20, 300000, 'warn');
    limiter.write('error', 'radio', 'Failed to start bluetoothd');
    limiter.write('error', 'radio', 'Failed to start bluetoothd');
    limiter.write('error', 'radio', 'Could not discover HBF-228T');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.every(([level]) => level === 'error')).toBe(true);
  });

  it('supports temporary verbose diagnostics when explicitly requested', () => {
    const sink = vi.fn();
    const limiter = new RadioLogLimiter(sink, () => 99, 300000, 'info');
    limiter.write('info', 'radio', 'Watcher ready');
    expect(sink).toHaveBeenCalledOnce();
  });
});
