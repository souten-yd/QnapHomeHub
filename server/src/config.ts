import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './types.js';

const DEFAULT_CONFIG: AppConfig = {
  hciDeviceId: 0,
  scanTimeoutMs: 10_000,
  apiFallback: false,
  scanOnStartup: false,
  devices: [],
};

export class ConfigStore {
  readonly file: string;
  private value: AppConfig = structuredClone(DEFAULT_CONFIG);

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  async load(): Promise<AppConfig> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<AppConfig>;
      this.value = this.normalize({ ...DEFAULT_CONFIG, ...raw });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.get();
  }

  get(): AppConfig {
    return structuredClone(this.value);
  }

  async update(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.value = this.normalize({ ...this.value, ...patch });
    await this.save();
    return this.get();
  }

  async replace(config: AppConfig): Promise<AppConfig> {
    this.value = this.normalize(config);
    await this.save();
    return this.get();
  }

  private normalize(config: AppConfig): AppConfig {
    return {
      hciDeviceId: Number.isInteger(config.hciDeviceId) && config.hciDeviceId >= 0 ? config.hciDeviceId : 0,
      scanTimeoutMs: Math.min(60_000, Math.max(3_000, Number(config.scanTimeoutMs) || 10_000)),
      apiFallback: Boolean(config.apiFallback),
      scanOnStartup: Boolean(config.scanOnStartup),
      devices: Array.isArray(config.devices) ? config.devices : [],
    };
  }

  private async save(): Promise<void> {
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}

export function readSecret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFile(file, 'utf8').then(value => value.trim()).catch(() => '');
  return Promise.resolve((process.env[name] ?? '').trim());
}
