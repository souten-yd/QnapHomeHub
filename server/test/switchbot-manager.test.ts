import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { SwitchBotManager } from '../src/switchbot-manager.js';

function createHarness(mode: 'press' | 'switch' | undefined = 'press') {
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
      ...(mode ? { bleServiceData: { mode } } : {}),
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
  it('uses the official short-press duration frame without rewriting Bot mode', async () => {
    const { manager, sendCommand, press } = createHarness('press');

    const result = await manager.command('BOT1', 'power');

    expect(result).toMatchObject({ success: true, action: 'power', holdSeconds: 0 });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      'ed:2e:c6:06:41:8f',
      Buffer.from([0x57, 0x0f, 0x08, 0x00]),
      expect.objectContaining({ expectResponse: true, validateResponse: true }),
    );
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('encodes force-hold duration as whole seconds, not deciseconds', async () => {
    const { manager, device, sendCommand } = createHarness('press');

    await manager.setPressDuration(device, 10, 'BOT1');

    expect(sendCommand).toHaveBeenCalledWith(
      'ed:2e:c6:06:41:8f',
      Buffer.from([0x57, 0x0f, 0x08, 0x0a]),
      expect.objectContaining({ expectResponse: true, validateResponse: true }),
    );
  });

  it('rejects PC power commands when BLE advertisement explicitly reports Switch mode', async () => {
    const { manager, sendCommand, press } = createHarness('switch');

    await expect(manager.command('BOT1', 'power')).rejects.toThrow(
      'Bot is in Switch mode. Change it to Press mode in the SwitchBot app, then scan again.',
    );
    expect(sendCommand).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it('continues safely when advertisement does not expose the current Bot mode', async () => {
    const { manager, sendCommand, press, debug } = createHarness(undefined);

    const result = await manager.command('BOT1', 'power');

    expect(result).toMatchObject({ success: true, action: 'power' });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      'warn',
      'command',
      'Bot Press mode could not be confirmed from advertisement; continuing without rewriting mode',
      { id: 'BOT1' },
    );
  });
});
