import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

export interface ProxyConfig {
  host: string;
  noisePsk: string;
  target: string;
  route: 'usb' | 'm5go';
}
const defaults: ProxyConfig = { host: '', noisePsk: '', target: '', route: 'usb' };
export function publicProxyConfig(config: ProxyConfig) {
  return { host: config.host, target: config.target, route: config.route, keyConfigured: Boolean(config.noisePsk) };
}
export function validateProxyConfig(previous: ProxyConfig, patch: Record<string, unknown>): ProxyConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid proxy configuration');
  if (Object.keys(patch).some(k => !['host', 'noisePsk', 'target', 'route'].includes(k))) throw new Error('Unknown proxy setting');
  const value = { ...previous, ...patch } as ProxyConfig;
  if (typeof value.host !== 'string' || value.host.length > 253 ||
      (value.host && !isIP(value.host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$/.test(value.host))) throw new Error('Invalid proxy host');
  if (typeof value.target !== 'string' || (value.target && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.target))) throw new Error('Invalid HBF-228T MAC');
  value.target = value.target.toUpperCase();
  if (typeof value.noisePsk !== 'string' || (value.noisePsk &&
      (!/^[A-Za-z0-9+/]{43}=$/.test(value.noisePsk) || Buffer.from(value.noisePsk, 'base64').length !== 32 ||
       !Buffer.from(value.noisePsk, 'base64').some(byte => byte !== 0)))) throw new Error('Invalid API encryption key');
  if (!['usb', 'm5go'].includes(value.route)) throw new Error('Invalid Bluetooth route');
  if (value.route === 'm5go' && (!value.host || !value.noisePsk || !value.target)) throw new Error('M5GO requires host, encryption key and HBF-228T MAC');
  return value;
}

/** Only the radio process holds/writes the key. Never include it in status/config responses. */
export class ProxyConfigStore {
  private value = { ...defaults };
  readonly file: string;
  constructor(directory: string) { this.file = path.join(directory, 'm5go.json'); }
  get() { return { ...this.value }; }
  async load() {
    try { this.value = validateProxyConfig(defaults, JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load M5GO configuration'); }
  }
  async update(patch: Record<string, unknown>) {
    const next = validateProxyConfig(this.value, patch);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(next) + '\n', { mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, this.file);
    this.value = next;
    return publicProxyConfig(next);
  }
}
