import { describe, expect, it, vi } from 'vitest';
import { DiskSampler, calculateDiskRates, parseDiskstats, safeEvents, safeRadio } from '../src/disk-io-diagnostics.js';
import { RadioLogLimiter } from '../src/radio-logging.js';

describe('Low-write radio diagnostics', () => {
  it('keeps routine radio messages out of persistent stdout and deduplicates errors', () => {
    let now = 100;
    const sink = vi.fn();
    const logger = new RadioLogLimiter(sink, () => now, 300_000, 'warn');
    for (let n = 0; n < 120; n++) {
      logger.write('info', 'radio', 'USB Bluetooth ownership transferred to SelfCare', { rssi: -70 });
      logger.write('warn', 'radio', 'Watch temporarily unavailable', { rssi: n });
    }
    expect(sink).toHaveBeenCalledTimes(1);
    now += 301_000;
    logger.write('warn', 'radio', 'Watch temporarily unavailable');
    logger.write('error', 'radio', 'Bluetooth error occurred');
    expect(sink).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(sink.mock.calls)).not.toContain('rssi');
  });

  it('computes per-physical-HDD IOPS from host-wide diskstats without double-counting RAID1', () => {
    const before = parseDiskstats([
      '8 0 sda 100 0 1000 50 200 0 1000 50 0 600 700',
      '8 16 sdb 100 0 1000 50 200 0 1000 50 0 600 700',
      '9 0 md0 50 0 500 50 100 0 400 50 0 500 700',
    ].join('\n'));
    const after = parseDiskstats([
      '8 0 sda 110 0 2000 50 240 0 2200 50 0 800 900',
      '8 16 sdb 110 0 2000 50 240 0 2200 50 0 800 900',
      '9 0 md0 55 0 700 50 120 0 900 50 0 700 900',
    ].join('\n'));
    const values = calculateDiskRates(before, after, 10);
    expect(values.map(x => x.device)).toEqual(['sda', 'sdb']);
    expect(values[0]!.writeIops).toBe(4);
    expect(values[1]!.writeIops).toBe(4);
    expect(values[0]!.writeMBps).toBe(0.061);
  });

  it('strips MACs and event details from shareable logs', () => {
    const rawEvents = [{ level: 'warn', at: '2026-10-11T00:00:00Z',
      source: 'ble', message: 'Device 12:34:56:78:AB:CD unavailable',
      details: { token: 'private-secret' } }];
    const cleaned = safeEvents(rawEvents);
    expect(JSON.stringify(cleaned)).not.toContain('12:34');
    expect(JSON.stringify(cleaned)).not.toContain('private-secret');
    expect(safeRadio({ shared: true, watchError: 'private path /secrets/123',
      bleKeys: 'private-key' })).toEqual({
      available: true, shared: true, watchError: 'present (details withheld)',
    });
  });

  it('samples only when invoked and holds report in RAM', async () => {
    let current = 0;
    const snapshot = vi.fn()
      .mockResolvedValueOnce(parseDiskstats('8 0 sda 0 0 0 0 0 0 0 0 0 0 0'))
      .mockResolvedValueOnce(parseDiskstats('8 0 sda 0 0 0 0 100 0 100 0 0 200 0'));
    const radio = vi.fn().mockResolvedValue({ shared: true, watchReady: false });
    const clock = () => current;
    const sleep = async (ms: number) => { current += ms; };
    const sampler = new DiskSampler(snapshot, sleep, clock);
    expect(snapshot).not.toHaveBeenCalled();
    const report = await sampler.run({ version: '0.3.15', radio, events: () => [] });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect((report as { disks: unknown[] }).disks).toHaveLength(1);
    expect(radio).toHaveBeenCalledTimes(2);
  });
});
