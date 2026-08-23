import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

async function command(file: string, args: string[] = []): Promise<string> {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: 3000 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
}

export async function diagnostics(): Promise<Record<string, unknown>> {
  let hci: string[] = [];
  try { hci = await fs.readdir('/sys/class/bluetooth'); } catch { /* optional */ }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nobleHciDeviceId: process.env.NOBLE_HCI_DEVICE_ID ?? '0',
    hci,
    uname: await command('uname', ['-a']),
    hciconfig: await command('hciconfig', ['-a']),
  };
}
