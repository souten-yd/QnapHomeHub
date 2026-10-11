import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SharedRadioManager } from '../src/shared-radio.js';
const config = () => ({ hciDeviceId: 0, scanTimeoutMs: 10000, apiFallback: false, scanOnStartup: false, devices: [] });
const target = 'AA:BB:CC:11:22:33';
const key = Buffer.alloc(32, 1).toString('base64');
const sync = { action: 'sync', adapter: 'hci0', device: { model: 'HBF-228T', address: target } };
const settings = { host: 'm5go.local', noisePsk: key, target, route: 'm5go' };
async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qhh-radio-'));
  const manager = new SharedRadioManager(config, '', '', undefined, directory) as any;
  return { manager, directory, close: async () => { await manager.cleanup(); await fs.rm(directory, { recursive: true, force: true }); } };
}
function request(socketPath: string, endpoint: string, payload?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: endpoint, method: payload ? 'POST' : 'GET' }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

describe('M5GO routing and Unix socket contract', () => {
  it('routes only registered HBF to M5GO, never automatically falls back on failure', async () => {
    const { manager, close } = await setup();
    try {
      expect(manager.usesProxy(sync)).toBe(false);
      await manager.proxyStore.update(settings);
      manager.proxyOperation = vi.fn(async () => { throw new Error('API disconnected'); });
      manager.startBlueZ = vi.fn(async () => { throw new Error('USB route'); });
      await expect(manager.arbiter.run('selfcare', sync)).rejects.toThrow('API disconnected');
      expect(manager.startBlueZ).not.toHaveBeenCalled();
      for (const device of [{ model:'HEM-6232T', address:target }, { model:'HBF-228T', address:'AA:BB:CC:99:88:77' }]) {
        await expect(manager.arbiter.run('selfcare', { ...sync, device })).rejects.toThrow('USB route');
      }
      expect(manager.proxyOperation).toHaveBeenCalledTimes(1);
      manager.callRaw = vi.fn(async () => ({ success: true }));
      await expect(manager.arbiter.run('homehub', { action:'command' })).resolves.toEqual({ success:true });
      expect(manager.callRaw).toHaveBeenCalledOnce();
    } finally { await close(); }
  });

  it('serializes route rollback after in-flight sync and resolves queued sync against the new route', async () => {
    const { manager, close } = await setup();
    try {
      await manager.proxyStore.update(settings);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const realProxy = manager.proxyOperation.bind(manager);
      manager.proxyOperation = async (payload: any) => {
        if (payload.action !== 'sync') return realProxy(payload);
        entered(); await new Promise<void>(resolve => { release = resolve; });
        return { records: [], invalid_records: 0 };
      };
      manager.startBlueZ = vi.fn(async () => { throw new Error('USB route'); });
      const first = manager.arbiter.run('selfcare', sync);
      await started;
      const rollback = manager.arbiter.run('selfcare', { action:'proxy-config', patch:{route:'usb'} });
      const second = manager.arbiter.run('selfcare', sync);
      const secondCheck = expect(second).rejects.toThrow('USB route');
      expect(manager.proxyStore.get().route).toBe('m5go');
      expect(manager.startBlueZ).not.toHaveBeenCalled();
      release(); await first; await rollback; await secondCheck;
      expect(manager.proxyStore.get().route).toBe('usb');
      expect(manager.proxyStore.get().noisePsk).toBe(key);
    } finally { await close(); }
  });

  it('preserves watch/health envelope, filters USB targets and reloads route after service restart', async () => {
    const { manager, directory, close } = await setup();
    try {
      manager.maintainWatch = async () => {};
      const socket = path.join(directory, 'ble.sock');
      await manager.listen(socket);
      const configured = await request(socket, '/proxy', { action:'config', patch:settings });
      expect(configured.status).toBe(200);
      expect(JSON.stringify(configured)).not.toContain(key);
      const watch = { adapter:'hci0', addresses:[target, 'AA:BB:CC:99:88:77'] };
      await request(socket, '/watch', watch);
      expect(manager.usbWatchAddresses()).toEqual(['AA:BB:CC:99:88:77']);
      manager.watchReady = true; manager.proxyReady = true;
      manager.watchSeen.set(target, { at:Date.now(), fingerprint:'abc', rssi:-51 });
      const result = await request(socket, '/watch', watch);
      expect(result.body).toMatchObject({ supported:true, ready:true, events:[{address:target, rssi:-51}] });
      const health = await request(socket, '/health');
      expect(health.body).toMatchObject({ mode:'homehub', shared:true, watchSupported:true, m5go:{route:'m5go', apiConnected:true} });
      expect(JSON.stringify(health)).not.toContain(key);
      manager.proxyReady = false; manager.proxyError = 'API disconnected';
      expect((await request(socket, '/watch', watch)).body).toMatchObject({ready:false,error:'API disconnected'});
      const restarted = new SharedRadioManager(config, '', '', undefined, directory) as any;
      await restarted.proxyStore.load();
      expect(restarted.usesProxy(sync)).toBe(true);
      expect(restarted.proxyStatus().apiConnected).toBe(false);
      await restarted.cleanup();
    } finally { await close(); }
  });
});
