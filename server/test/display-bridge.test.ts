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
  const worker = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), pid: 999,
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
  expect(saved).toMatchObject({ enabled: true, selfcare_url: 'http://127.0.0.1:17863', schedule: 'midnight', profiles });
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


it('reports the next Japan midnight and daily freshness without a polling interval', async () => {
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(Date.parse('2026-10-12T14:59:59Z'));
    const worker = child(); spawn.mockReturnValue(worker);
    await bridge.configure({ enabled: true, profiles });
    expect(bridge.status()).toMatchObject({ schedule: 'midnight', timezone: 'Asia/Tokyo', intervalSeconds: null,
      nextRefreshAt: Date.parse('2026-10-12T15:00:00Z'), lastAcceptedAt: null });
    worker.stdout.write('display: snapshot accepted\n');
    clock.mockReturnValue(Date.parse('2026-10-13T14:59:59Z'));
    expect(bridge.status().stale).toBe(false);
    clock.mockReturnValue(Date.parse('2026-10-13T16:00:00Z'));
    expect(bridge.status().stale).toBe(true);
    expect(bridge.status().nextRefreshAt).toBe(Date.parse('2026-10-13T15:00:00Z') + 86400000);
    await bridge.configure({ enabled: false });
    expect(bridge.status().nextRefreshAt).toBeNull();
  } finally { clock.mockRestore(); }
});


it('forwards only received configured HBF measurements without waiting for display or exposing keys', async () => {
  const worker = child(); spawn.mockReturnValue(worker);
  await bridge.configure({ enabled: true, profiles });
  const write = vi.spyOn(worker.stdin, 'write');
  const request = { action: 'sync', key: 'never-forward-key', device: { model: 'HBF-228T' } };
  const record = { user_id: 'example', kind: 'body_composition', measured_at: '2026-10-12T00:00:00Z',
    raw: 'private-raw', values: { weight: 70, body_fat: 25, extra: 'omit' } };
  for (const [req, result] of [[{ ...request, action: 'pair' }, { records: [record] }],
    [request, { records: [] }], [request, { error: 'failed', records: [record] }],
    [request, { registration_only: true, records: [record] }],
    [{ ...request, device: { model: 'HEM-6232T' } }, { records: [record] }],
    [request, { records: [{ ...record, user_id: 'another' }] }]]) bridge.measurement(req, result);
  expect(write).not.toHaveBeenCalled();
  expect(bridge.measurement(request, { records: [record] })).toBeUndefined();
  const message = String(write.mock.calls[0]![0]);
  expect(JSON.parse(message)).toEqual({ event: 'measurement', records: [{ user_id: 'example', kind: 'body_composition',
    measured_at: record.measured_at, values: { weight: 70, body_fat: 25 } }] });
  expect(message).not.toContain('never-forward-key'); expect(message).not.toContain('private-raw');
  expect(bridge.status().lastMeasurementAt).toBeNull();
  worker.stdout.write('display: measurement accepted\n');
  expect(bridge.status().lastMeasurementAt).not.toBeNull();
  expect(JSON.stringify(bridge.status())).not.toContain('body_fat');
  write.mockImplementation(() => { throw new Error('pipe full'); });
  expect(() => bridge.measurement(request, { records: [record] })).not.toThrow();
  expect(bridge.status().measurementError).toBe('Measurement display unavailable');
  await bridge.configure({ enabled: false });
  write.mockClear(); bridge.measurement(request, { records: [record] }); expect(write).not.toHaveBeenCalled();
});
