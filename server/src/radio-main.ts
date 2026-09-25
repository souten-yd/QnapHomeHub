import fs from 'node:fs';
import { readSecret } from './config.js';
import { SharedRadioManager } from './shared-radio.js';
import type { AppConfig } from './types.js';
const fallback: AppConfig = { hciDeviceId: 0, scanTimeoutMs: 10000, apiFallback: false, scanOnStartup: false, devices: [] };
function config(): AppConfig {
  try {
    const value = { ...fallback, ...JSON.parse(fs.readFileSync('/homehub/settings.json', 'utf8')) };
    if (!Number.isInteger(value.hciDeviceId) || value.hciDeviceId < 0 || value.hciDeviceId > 99 || !Array.isArray(value.devices)) {
      throw new Error('Invalid HomeHub Bluetooth settings');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
const [token, secret] = await Promise.all([readSecret('SWITCHBOT_TOKEN'), readSecret('SWITCHBOT_SECRET')]);
const manager = new SharedRadioManager(config, token, secret,
  (level, source, message) => console.log(JSON.stringify({ level, source, message })));
await manager.listen();
const shutdown = () => { void manager.cleanup().finally(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log('Shared USB Bluetooth radio ready; SelfCare preferred, Unix socket /radio/ble.sock');
