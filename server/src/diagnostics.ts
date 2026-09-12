import fs from 'node:fs/promises';
import os from 'node:os';
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

async function defaultRouteInterface(): Promise<string | undefined> {
  try {
    const text = await fs.readFile('/proc/net/route', 'utf8');
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 2 && fields[1] === '00000000') {
        const name = fields[0];
        if (name && name !== 'lo' && !/^(docker|veth|br-|tailscale)/.test(name)) return name;
      }
    }
  } catch { /* optional */ }
  return undefined;
}

export async function diagnostics(): Promise<Record<string, unknown>> {
  let hci: string[] = [];
  try { hci = await fs.readdir('/sys/class/bluetooth'); } catch { /* optional */ }

  const interfaces = os.networkInterfaces();
  const network = Object.entries(interfaces).map(([name, addresses]) => ({
    name,
    addresses: (addresses ?? []).map(address => ({
      address: address.address,
      family: address.family,
      internal: address.internal,
      scopeid: address.scopeid,
    })),
  }));
  const ipv6Addresses = network.flatMap(item => item.addresses
    .filter(address => address.family === 'IPv6' && !address.internal)
    .map(address => ({ interface: item.name, address: address.address, scopeid: address.scopeid })));
  const defaultInterface = await defaultRouteInterface();

  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nobleHciDeviceId: process.env.NOBLE_HCI_DEVICE_ID ?? '0',
    hci,
    uname: await command('uname', ['-a']),
    hciconfig: await command('hciconfig', ['-a']),
    matterNetwork: {
      defaultInterface,
      ipv6Ready: ipv6Addresses.length > 0,
      ipv6Addresses,
      interfaces: network,
      ipv6Route: await command('ip', ['-6', 'route']),
    },
  };
}
