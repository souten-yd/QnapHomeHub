import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SerialQueue } from './queue.js';

interface Profile { user_id: string; label: string }
interface DisplayConfig { enabled: boolean; profiles: Profile[] }
const defaults: DisplayConfig = { enabled: false, profiles: [] };

function validate(previous: DisplayConfig, patch: unknown): DisplayConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid display configuration');
  const p = patch as Record<string, unknown>;
  if (Object.keys(p).some(k => !['enabled', 'profiles'].includes(k))) throw new Error('Unknown display setting');
  const next = { ...previous, ...p } as DisplayConfig;
  if (typeof next.enabled !== 'boolean' || !Array.isArray(next.profiles) || next.profiles.length > 4 ||
      (next.enabled && !next.profiles.length)) throw new Error('Display requires one to four users');
  const seen = new Set<string>();
  for (const profile of next.profiles) {
    if (!profile || typeof profile !== 'object' || Object.keys(profile).some(k => !['user_id', 'label'].includes(k)) ||
        typeof profile.user_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.user_id) || seen.has(profile.user_id) ||
        typeof profile.label !== 'string' || !/^[A-Za-z0-9 ._-]{1,16}$/.test(profile.label)) throw new Error('Invalid display user');
    seen.add(profile.user_id);
  }
  return structuredClone(next);
}

/** A separate process with no radio ownership or GATT calls. Disabled by default. */
export class DisplayBridge {
  private config = structuredClone(defaults);
  private worker?: ChildProcess;
  private retryAt = 0;
  private closing = false;
  private configuring = false;
  private lastAcceptedAt?: number;
  private lastMeasurementAt?: number;
  private measurementError?: string;
  private error?: string;
  private readonly queue = new SerialQueue();
  private readonly file: string;

  constructor(private readonly directory: string, private readonly stop: (child: ChildProcess | undefined) => Promise<void>) {
    this.file = path.join(directory, 'm5go-display.json');
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.config = validate(defaults, { enabled: saved.enabled, profiles: saved.profiles });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = 'Display configuration unavailable';
    }
  }

  status() {
    return { enabled: this.config.enabled, profileCount: this.config.profiles.length,
      running: Boolean(this.worker && this.worker.exitCode === null && this.worker.signalCode === null),
      schedule: 'midnight', timezone: 'Asia/Tokyo', intervalSeconds: null,
      nextRefreshAt: this.config.enabled ? (Math.floor((Date.now() + 9 * 3600000) / 86400000) + 1) * 86400000 - 9 * 3600000 : null,
      lastAcceptedAt: this.lastAcceptedAt ?? null,
      lastMeasurementAt: this.lastMeasurementAt ?? null, measurementError: this.measurementError ?? null,
      stale: !this.lastAcceptedAt || Date.now() - this.lastAcceptedAt > 25 * 3600000, error: this.error ?? null };
  }

  configure(patch: unknown) {
    return this.queue.run(async () => {
      if (this.closing) throw new Error('Display service is stopping');
      const next = validate(this.config, patch);
      this.configuring = true;
      try {
        await this.stop(this.worker);
        this.worker = undefined;
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        // Endpoint/timezone are fixed locally; this API cannot read arbitrary URLs.
        const saved = { ...next, selfcare_url: 'http://127.0.0.1:17863', timezone: 'Asia/Tokyo', schedule: 'midnight' };
        await fs.writeFile(this.file + '.tmp', JSON.stringify(saved) + '\n', { mode: 0o600 });
        await fs.rename(this.file + '.tmp', this.file);
        this.config = next;
        this.retryAt = 0; this.error = undefined; this.lastAcceptedAt = undefined;
        this.lastMeasurementAt = undefined; this.measurementError = undefined;
      } finally { this.configuring = false; }
      this.maintain();
      return this.status();
    });
  }

  /** Copy only completed HBF measurements; never block or retry the saving path. */
  measurement(request: any, result: any) {
    if (!this.config.enabled || this.closing || this.configuring || request?.action !== 'sync' ||
        request.device?.model !== 'HBF-228T' || result?.registration_only || result?.error ||
        !Array.isArray(result?.records) || !result.records.length) return;
    const input = this.worker?.stdin;
    if (!input || input.destroyed || !input.writable || input.writableLength > 65536 || result.records.length > 128) {
      this.measurementError = 'Measurement display unavailable'; return;
    }
    try {
      const users = new Set(this.config.profiles.map(p => p.user_id));
      const records = result.records.filter((r: any) => r && users.has(r.user_id) && r.kind === 'body_composition')
        .map((r: any) => ({ user_id: r.user_id, kind: r.kind, measured_at: r.measured_at,
          values: { weight: r.values?.weight, body_fat: r.values?.body_fat } }));
      if (!records.length) return;
      const event = JSON.stringify({ event: 'measurement', records }) + '\n';
      if (Buffer.byteLength(event) > 60000) throw new Error('Display event too large');
      input.write(event, error => { if (error) this.measurementError = 'Measurement display unavailable'; });
    } catch { this.measurementError = 'Measurement display unavailable'; }
  }

  maintain() {
    if (this.closing || this.configuring || !this.config.enabled || this.worker || Date.now() < this.retryAt) return;
    try {
      const child = spawn('/opt/ble-proxy/bin/python', ['/app/ble/esp_display_bridge.py',
        '--config', this.file, '--proxy-config', path.join(this.directory, 'm5go.json')],
      { stdio: ['pipe', 'pipe', 'ignore'] });
      this.worker = child;
      child.stdin!.on('error', () => { this.measurementError = 'Measurement display unavailable'; });
      let buffer = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', chunk => {
        if (this.worker !== child) return;
        buffer += chunk;
        if (buffer.length > 4096) { child.kill('SIGTERM'); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line === 'display: snapshot accepted') { this.lastAcceptedAt = Date.now(); this.error = undefined; }
          else if (line === 'display: update unavailable; previous screen will become stale') this.error = 'Display update unavailable';
          else if (line === 'display: measurement accepted') {
            this.lastAcceptedAt = Date.now(); this.lastMeasurementAt = Date.now(); this.measurementError = undefined;
          } else if (line === 'display: measurement unavailable') this.measurementError = 'Measurement display unavailable';
        }
      });
      const failed = () => {
        if (this.worker !== child) return;
        this.worker = undefined;
        this.error = 'Display worker unavailable';
        this.retryAt = Date.now() + 30000;
      };
      child.once('error', failed);
      child.once('exit', failed);
    } catch {
      this.error = 'Display worker unavailable'; this.retryAt = Date.now() + 30000;
    }
  }

  async close() {
    this.closing = true;
    await this.queue.run(async () => { await this.stop(this.worker); this.worker = undefined; });
  }
}
