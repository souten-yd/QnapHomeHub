import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<object>(), spawn }));
import { DisplayBridge } from '../src/display-bridge.js';
import { SharedRadioManager, stopProcess } from '../src/shared-radio.js';

let directory: string;
let bridge: DisplayBridge;
function child() {
  const worker = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 999,
    exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() });
  worker.kill.mockImplementation((signal: string) => { worker.signalCode = signal; worker.emit('exit', null, signal); return true; });
  return worker;
}
const profiles = [{ user_id: 'example', label: 'USER 1' }];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'display-bridge-'));
  bridge = new DisplayBridge(directory, stopProcess);
  spawn.mockReset();
});
afterEach(async () => { await bridge.close(); await fs.rm(directory, { force: true, recursive: true }); });

it('defaults off and rejects arbitrary endpoints, duplicates and malformed profiles without spawning', async () => {
  await bridge.load(); bridge.maintain(); expect(spawn).not.toHaveBeenCalled();
  for (const patch of [{ enabled: true }, { enabled: true, profiles, selfcare_url: 'http://remote/' },
    { enabled: true, profiles: [profiles[0], profiles[0]] }, { enabled: true, profiles: [{ user_id: '../db', label: 'USER' }] },
    { enabled: true, profiles: [{ user_id: 'valid', label: 'x'.repeat(17) }] }]) {
    await expect(bridge.configure(patch)).rejects.toThrow();
  }
  expect(spawn).not.toHaveBeenCalled();
  expect(bridge.status()).toMatchObject({ enabled: false, profileCount: 0, running: false });
});

it('persists read-only settings, counts only an acknowledged update, and disables just its worker', async () => {
  const worker = child(); spawn.mockReturnValue(worker);
  await bridge.configure({ enabled: true, profiles });
  expect(spawn.mock.calls[0]![1]).toEqual(['/app/ble/esp_display_bridge.py', '--config',
    path.join(directory, 'm5go-display.json'), '--proxy-config', path.join(directory, 'm5go.json')]);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'm5go-display.json'), 'utf8'));
  expect(saved).toMatchObject({ enabled: true, selfcare_url: 'http://127.0.0.1:17863', interval_seconds: 60, profiles });
  expect((await fs.stat(path.join(directory, 'm5go-display.json'))).mode & 0o777).toBe(0o600);
  worker.stdout.write('display: snapshot validated\n'); expect(bridge.status().lastAcceptedAt).toBeNull();
  worker.stdout.write('display: snapshot acc'); worker.stdout.write('epted\n');
  expect(bridge.status()).toMatchObject({ enabled: true, running: true, stale: false, error: null });
  expect(JSON.stringify(bridge.status())).not.toContain('example');
  worker.stdout.write('display: update unavailable; previous screen will become stale\n');
  expect(bridge.status().error).toBe('Display update unavailable');
  await bridge.configure({ enabled: false });
  expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
  bridge.maintain(); expect(spawn).toHaveBeenCalledTimes(1);
});

it('resumes persisted configuration after restart and backs off process failure', async () => {
  const first = child(), second = child(), third = child();
  spawn.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
  await bridge.configure({ enabled: true, profiles }); await bridge.close();
  bridge = new DisplayBridge(directory, stopProcess); await bridge.load(); bridge.maintain();
  expect(spawn).toHaveBeenCalledTimes(2);
  second.exitCode = 1; second.emit('exit', 1, null);
  bridge.maintain(); expect(spawn).toHaveBeenCalledTimes(2);
  (bridge as any).retryAt = 0; bridge.maintain(); expect(spawn).toHaveBeenCalledTimes(3);
});

it('leaves Bluetooth startup possible when its own stored configuration is corrupt', async () => {
  await fs.writeFile(path.join(directory, 'm5go-display.json'), '{bad');
  await bridge.load(); bridge.maintain();
  expect(bridge.status()).toMatchObject({ enabled: false, error: 'Display configuration unavailable' });
  expect(spawn).not.toHaveBeenCalled();
});

it('serializes reconfiguration and stops before the next worker starts', async () => {
  const first = child(), second = child(); spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await bridge.configure({ enabled: true, profiles });
  await Promise.all([bridge.configure({ profiles: [{ user_id: 'second', label: 'USER 2' }] }), bridge.configure({ enabled: false })]);
  expect(first.kill).toHaveBeenCalled(); expect(second.kill).toHaveBeenCalled();
  expect(bridge.status()).toMatchObject({ enabled: false, running: false });
});

it('routes display management outside the Bluetooth arbiter and watcher stop path', async () => {
  const manager = new SharedRadioManager(() => ({ hciDeviceId: 0, scanTimeoutMs: 10000,
    apiFallback: false, scanOnStartup: false, devices: [] }), '', '', undefined, directory);
  const socketPath = path.join(directory, 'test.sock');
  const radio = vi.spyOn(manager.arbiter, 'run');
  const stopWatch = vi.spyOn(manager as any, 'stopWatcher');
  const worker = child(); spawn.mockReturnValue(worker);
  function request(payload: unknown) {
    return new Promise<any>((resolve, reject) => {
      const req = http.request({ socketPath, path: '/proxy', method: 'POST' }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(JSON.stringify(payload));
    });
  }
  try {
    await manager.listen(socketPath);
    expect((await request({ action: 'display-config', patch: { enabled: true, profiles } })).status).toBe(200);
    expect((await request({ action: 'display-status' })).body.enabled).toBe(true);
    expect(radio).not.toHaveBeenCalled(); expect(stopWatch).not.toHaveBeenCalled();
  } finally { await manager.cleanup(); }
});
