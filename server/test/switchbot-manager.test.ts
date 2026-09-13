import { describe, expect, it, vi } from 'vitest';

import { SwitchBotManager } from '../src/switchbot-manager.js';

function createHarness() {
  const debug = vi.fn();
  const manager = new SwitchBotManager(
    () => ({
      hciDeviceId: 0,
      scanTimeoutMs: 5000,
      apiFallback: false,
      scanOnStartup: false,
      devices: [],
    }),
    '',
    '',
    debug,
  ) as any;

  const sendCommand = vi.fn().mockResolvedValue(Buffer.from([0x01]));
  const press = vi.fn().mockResolvedValue(true);
  const device = {
    bleConnection: { sendCommand },
    getInfo: () => ({
      id: 'BOT1',
      mac: 'ed:2e:c6:06:41:8f',
      deviceType: 'Bot',
      connectionTypes: ['ble'],
      activeConnection: 'ble',
    }),
    hasBLE: () => true,
    hasAPI: () => false,
    press,
    on: vi.fn(),
    off: vi.fn(),
  };

  manager.initialized = true;
  manager.client = { devices: new Map() };
  manager.discovered.set('BOT1', device);

  return { manager, device, sendCommand, press, debug };
}

describe('SwitchBotManager PC power BLE commands', () => {
  it('uses the official Bot mode and short-press frames without calling node-switchbot setters', async () => {
    const { manager, sendCommand, press } = createHarness();

    const result = await manager.command('BOT1', 'power');

    expect(result).toMatchObject({ success: true, action: 'power', holdSeconds: 0 });
    expect(sendCommand).toHaveBeenNthCalledWith(
      1,
      'ed:2e:c6:06:41:8f',
      Buffer.from([0x57, 0x03, 0x64, 0x00]),
      expect.objectContaining({ expectResponse: true, validateResponse: true }),
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      'ed:2e:c6:06:41:8f',
      Buffer.from([0x57, 0x0f, 0x08, 0x00]),
      expect.objectContaining({ expectResponse: true, validateResponse: true }),
    );
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('encodes force-hold duration as whole seconds, not deciseconds', async () => {
    const { manager, device, sendCommand } = createHarness();

    await manager.setPressDuration(device, 10, 'BOT1');

    expect(sendCommand).toHaveBeenCalledWith(
      'ed:2e:c6:06:41:8f',
      Buffer.from([0x57, 0x0f, 0x08, 0x0a]),
      expect.objectContaining({ expectResponse: true, validateResponse: true }),
    );
  });

  it('does not block a press when Press-mode confirmation itself fails', async () => {
    const { manager, sendCommand, press } = createHarness();
    sendCommand
      .mockRejectedValueOnce(new Error('mode write rejected'))
      .mockResolvedValueOnce(Buffer.from([0x01]));

    const result = await manager.command('BOT1', 'power');

    expect(result).toMatchObject({ success: true, action: 'power' });
    expect(press).toHaveBeenCalledTimes(1);
  });
});
