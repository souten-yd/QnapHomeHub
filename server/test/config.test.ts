import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('ConfigStore', () => {
  it('normalizes unsafe values', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qnaphomehub-'));
    const store = new ConfigStore(dir);
    await store.load();
    const config = await store.update({ hciDeviceId: -4, scanTimeoutMs: 1 });
    expect(config.hciDeviceId).toBe(0);
    expect(config.scanTimeoutMs).toBe(3000);
  });

  it('adds safe defaults to legacy devices and clamps force hold duration', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qnaphomehub-'));
    const store = new ConfigStore(dir);
    await store.load();
    const baseDevice = {
      id: 'BOT1',
      name: 'PC',
      deviceType: 'Bot',
      mode: 'press' as const,
      exposeMatter: true,
      matterType: 'outlet' as const,
      createdAt: new Date().toISOString(),
    };
    const legacy = await store.update({ devices: [baseDevice] });
    expect(legacy.devices[0]?.controlProfile).toBe('standard');
    expect(legacy.devices[0]?.forceHoldSeconds).toBe(10);

    const pcPower = await store.update({ devices: [{ ...baseDevice, controlProfile: 'pc-power', forceHoldSeconds: 99 }] });
    expect(pcPower.devices[0]?.controlProfile).toBe('pc-power');
    expect(pcPower.devices[0]?.forceHoldSeconds).toBe(30);
  });
});
