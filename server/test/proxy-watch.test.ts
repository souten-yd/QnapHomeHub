import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<object>(), spawn }));
import { SharedRadioManager } from '../src/shared-radio.js';
const config = () => ({hciDeviceId:0, scanTimeoutMs:10000, apiFallback:false, scanOnStartup:false, devices:[]});
function worker() {
  const child = Object.assign(new EventEmitter(), {stdout:new PassThrough(), stdin:new PassThrough(), pid:123,
    exitCode:null as number | null, signalCode:null as string | null, kill:vi.fn()});
  child.kill.mockImplementation((signal: string) => { child.signalCode = signal; child.emit('exit', null, signal); return true; });
  return child;
}
it('reconnects the remote advertisement/API watcher with backoff without any GATT retry', async () => {
  const manager = new SharedRadioManager(config, '', '') as any;
  manager.proxyStore.get = () => ({host:'m5go.local', noisePsk:Buffer.alloc(32,1).toString('base64'), target:'AA:BB:CC:11:22:33', route:'m5go'});
  manager.watchAddresses = ['AA:BB:CC:11:22:33']; manager.watchLease = Date.now() + 60000;
  const first = worker(); const second = worker(); spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await manager.maintainProxyWatch();
  first.stdout.write(JSON.stringify({ready:true,api_connected:true})+'\n');
  expect(manager.proxyStatus().apiConnected).toBe(true);
  first.stdout.write(JSON.stringify({address:'AA:BB:CC:11:22:33',rssi:-55,fingerprint:'test',advertisement:{}})+'\n');
  expect(manager.watchSeen.get('AA:BB:CC:11:22:33').rssi).toBe(-55);
  first.stdout.write(JSON.stringify({ready:false,error:'API disconnected'})+'\n');
  first.exitCode = 0; first.emit('exit',0,null);
  expect(manager.proxyStatus().apiConnected).toBe(false);
  expect(manager.proxyNextStart).toBeGreaterThan(Date.now());
  await manager.maintainProxyWatch(); expect(spawn).toHaveBeenCalledTimes(1);
  manager.proxyNextStart = 0;
  await manager.maintainProxyWatch();
  second.stdout.write(JSON.stringify({ready:true,api_connected:true})+'\n');
  expect(manager.proxyStatus().apiConnected).toBe(true);
  expect(manager.proxyStatus().error).toBeUndefined();
  expect(manager.proxyLastSync).toBeUndefined();
  expect(spawn).toHaveBeenCalledTimes(2);
  await manager.cleanup();
  expect(second.kill).toHaveBeenCalledWith('SIGTERM');
});
