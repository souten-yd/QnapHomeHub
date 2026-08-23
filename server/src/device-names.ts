import type { RegisteredDevice } from './types.js';

export function uniqueDeviceName(requested: string, devices: RegisteredDevice[], excludeId?: string): string {
  const base = requested.trim() || 'SwitchBot';
  const used = new Set(
    devices
      .filter(device => device.id !== excludeId)
      .map(device => device.name.trim().toLocaleLowerCase()),
  );
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('Unable to generate a unique device name');
}
