import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProxyConfigStore, publicProxyConfig, validateProxyConfig } from '../src/proxy-config.js';
const key = Buffer.alloc(32, 1).toString('base64');
describe('M5GO configuration', () => {
  it('defaults to USB, stores a private key, redacts it and survives restart and rollback', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homehub-proxy-'));
    try {
      const store = new ProxyConfigStore(dir); await store.load();
      expect(store.get().route).toBe('usb');
      const saved = await store.update({ host: 'm5go.local', noisePsk: key, target: 'aa:bb:cc:11:22:33', route: 'm5go' });
      expect(saved).toEqual({ host: 'm5go.local', target: 'AA:BB:CC:11:22:33', route: 'm5go', keyConfigured: true });
      expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
      const restarted = new ProxyConfigStore(dir); await restarted.load();
      expect(restarted.get()).toEqual(store.get());
      await restarted.update({ route: 'usb' });
      expect(restarted.get().noisePsk).toBe(key);
      expect(JSON.stringify(publicProxyConfig(restarted.get()))).not.toContain(key);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid settings without changing stored state', async () => {
    const store = new ProxyConfigStore('/unused');
    for (const patch of [{route:'m5go'}, {host:'http://host'}, {noisePsk:'x'}, {target:'bad'}, {route:'auto'}, {extra:true}]) {
      expect(() => validateProxyConfig(store.get(), patch)).toThrow();
      expect(store.get().route).toBe('usb');
    }
  });
});
