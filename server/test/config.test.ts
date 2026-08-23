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
});
