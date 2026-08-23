import { describe, expect, it } from 'vitest';
import { uniqueDeviceName } from '../src/device-names.js';
import type { RegisteredDevice } from '../src/types.js';

const device = (id: string, name: string): RegisteredDevice => ({
  id,
  name,
  deviceType: 'Bot',
  mode: 'press',
  exposeMatter: true,
  matterType: 'outlet',
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('uniqueDeviceName', () => {
  it('keeps an unused name', () => {
    expect(uniqueDeviceName('Desk', [device('1', 'Bot')])).toBe('Desk');
  });

  it('suffixes duplicate SwitchBot names', () => {
    const devices = [device('1', 'Bot'), device('2', 'Bot 2')];
    expect(uniqueDeviceName('Bot', devices)).toBe('Bot 3');
  });

  it('ignores the edited device itself', () => {
    const devices = [device('1', 'Bot'), device('2', 'Desk')];
    expect(uniqueDeviceName('Bot', devices, '1')).toBe('Bot');
  });
});
