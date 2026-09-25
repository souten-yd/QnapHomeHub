import http from 'node:http';
import type { AppConfig, DiscoveredDevice } from './types.js';
export class RadioClientManager {
  private discovered: DiscoveredDevice[] = [];
  constructor(_getConfig: () => AppConfig, _token: string, _secret: string, _debug?: unknown) {}
  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}
  listDiscovered() { return structuredClone(this.discovered); }
  private request<T>(payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: '/radio/ble.sock', path: payload ? '/homehub' : '/health',
        method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, timeout: payload ? 240000 : 3000 }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; if (text.length > 4 * 1024 * 1024) req.destroy(new Error('Radio response too large')); });
        res.on('end', () => {
          try { const result = JSON.parse(text); if (res.statusCode !== 200) throw new Error(result.error || 'Radio service failed'); resolve(result); }
          catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Radio queue timed out')));
      req.on('error', reject);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  }
  status() { return this.request(); }
  async scan(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    this.discovered = await this.request({ action: 'scan', timeoutMs });
    return this.listDiscovered();
  }
  command(deviceId: string, command: string, password?: string, holdSeconds = 10) {
    return this.request({ action: 'command', deviceId, command, password, holdSeconds });
  }
}
