/** Read-only, explicitly triggered physical disk diagnostic.
 * Linux /proc/diskstats is host-wide even in standard Docker PID namespaces.
 * It cannot attribute writes to a host bluetoothd PID from this container.
 */
import fs from 'node:fs/promises';

export type DiskCounter = {
  readOps: number; writeOps: number; readSectors: number; writeSectors: number; busyMs: number;
};

export function parseDiskstats(source: string): Record<string, DiskCounter> {
  const result: Record<string, DiskCounter> = {};
  for (const line of source.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2];
    // Whole, physical disks only. In RAID1 measure each physical member separately.
    if (!name || !/^(?:sd[a-z]+|hd[a-z]+|nvme\d+n\d+)$/.test(name)) continue;
    const indices = [3, 5, 7, 9, 12];
    const values = indices.map(i => Number(fields[i]));
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) continue;
    result[name] = {
      readOps: values[0], readSectors: values[1], writeOps: values[2],
      writeSectors: values[3], busyMs: values[4],
    };
  }
  return result;
}

export function calculateDiskRates(
  before: Record<string, DiskCounter>, after: Record<string, DiskCounter>, seconds: number,
) {
  if (!(seconds > 0)) throw new Error('Invalid I/O sampling interval');
  return Object.entries(before).flatMap(([device, first]) => {
    const last = after[device];
    if (!last) return [];
    const differences = {
      readOps: last.readOps - first.readOps,
      writeOps: last.writeOps - first.writeOps,
      readSectors: last.readSectors - first.readSectors,
      writeSectors: last.writeSectors - first.writeSectors,
      busyMs: last.busyMs - first.busyMs,
    };
    if (Object.values(differences).some(x => x < 0)) return [];
    const fixed = (n: number) => Number(n.toFixed(3));
    return [{
      device,
      readIops: fixed(differences.readOps / seconds),
      writeIops: fixed(differences.writeOps / seconds),
      readMBps: fixed(differences.readSectors * 512 / seconds / 1_000_000),
      writeMBps: fixed(differences.writeSectors * 512 / seconds / 1_000_000),
      busyPercent: fixed(Math.min(100, differences.busyMs / seconds / 10)),
    }];
  }).sort((a, b) => a.device.localeCompare(b.device));
}

export type ReportEvent = { at?: string; level?: string; source?: string; message?: string };
export function safeEvents(events: ReportEvent[]) {
  // Never include event.details: BLE measurements, MACs, and tokens may appear there.
  return events.slice(-40).map(event => ({
    at: event.at,
    level: event.level,
    source: event.source,
    message: String(event.message ?? '').slice(0, 180)
      .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '[redacted-mac]')
      .replace(/(?:https?:\/\/)[^\s]+/gi, '[redacted-url]'),
  }));
}

const allowedRadioFields = [
  'shared', 'active', 'pending', 'bluezMode', 'bluezError', 'watchReady', 'watchError',
  'watchSupported', 'bridge', 'mode', 'preferredOwner', 'bleak', 'dbus', 'adapter',
] as const;
export function safeRadio(input: unknown) {
  if (!input || typeof input !== 'object') return { available: false };
  const raw = input as Record<string, unknown>;
  const result: Record<string, unknown> = { available: true };
  for (const key of allowedRadioFields) {
    const value = raw[key];
    if (typeof value === 'boolean' || typeof value === 'number') result[key] = value;
    else if (typeof value === 'string') result[key] = key.endsWith('Error') ?
      'present (details withheld)' : value.slice(0, 50);
  }
  return result;
}

export function diskReportText(report: unknown) {
  return 'QnapHomeHub diagnostic (no NAS log file written)\n' + JSON.stringify(report, null, 2);
}

export class DiskSampler {
  private active?: Promise<unknown>;
  constructor(
    private readonly read = async () => parseDiskstats(await fs.readFile('/proc/diskstats', 'utf8')),
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private readonly clock = () => Date.now(),
  ) {}

  run(input: { version: string; radio: () => Promise<unknown>; events: () => ReportEvent[] }, seconds = 15) {
    if (this.active) return this.active;
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 30) throw new Error('Invalid diagnostic duration');
    this.active = (async () => {
      const [radioStart, first] = await Promise.all([
        input.radio().then(safeRadio).catch(() => ({ available: false })),
        this.read(),
      ]);
      const start = this.clock();
      await this.sleep(seconds * 1000);
      const end = this.clock();
      const [radioEnd, last] = await Promise.all([
        input.radio().then(safeRadio).catch(() => ({ available: false })),
        this.read(),
      ]);
      return {
        schema: 1, mode: 'read-only', measuredAt: new Date(end).toISOString(),
        durationSeconds: Number(((end - start) / 1000).toFixed(3)),
        homehubVersion: input.version,
        radio: { before: radioStart, after: radioEnd },
        disks: calculateDiskRates(first, last, (end - start) / 1000),
        recentEvents: safeEvents(input.events()),
        limits: [
          'Kernel counters represent HOST-WIDE disk I/O, not Bluetooth-only I/O.',
          'Docker cannot attribute host bluetoothd PID writes without explicit host-side measurement.',
          'No Bluetooth scan, pairing, device sync, HCI reset or Docker restart was performed.',
          'This sample writes no QNAP log or settings file.',
        ],
      };
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
}
