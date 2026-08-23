import fs from 'node:fs/promises';
import {
  type BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffLight,
  onOffPlugInUnit,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { OnOff } from 'matterbridge/matter/clusters';

type Device = { id:string; name:string; deviceType:string; mac?:string; mode:'press'|'switch'; exposeMatter:boolean; matterType:'outlet'|'light' };
type Config = BasePlatformConfig;

async function readToken(): Promise<string> {
  const file = process.env.HOMEHUB_INTERNAL_TOKEN_FILE;
  if (file) return (await fs.readFile(file, 'utf8')).trim();
  return (process.env.HOMEHUB_INTERNAL_TOKEN ?? '').trim();
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: Config): QnapHomeHubPlatform {
  return new QnapHomeHubPlatform(matterbridge, log, config);
}

export class QnapHomeHubPlatform extends MatterbridgeDynamicPlatform {
  private readonly baseUrl = process.env.QNAP_HOME_HUB_URL ?? 'http://127.0.0.1:8787';
  private token = '';
  private timer?: NodeJS.Timeout;
  private registered = new Set<string>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: Config) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion === 'function' && !this.verifyMatterbridgeVersion('3.10.0')) {
      throw new Error('QnapHomeHub requires Matterbridge >= 3.10.0');
    }
  }

  override async onStart(): Promise<void> {
    await this.ready;
    this.token = await readToken();
    if (!this.token) this.log.error('HOMEHUB_INTERNAL_TOKEN is not configured');
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile().catch(error => this.log.error(`Reconcile failed: ${String(error)}`)), 15_000);
    this.timer.unref();
  }

  override async onShutdown(reason?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await super.onShutdown(reason);
  }

  private async reconcile(): Promise<void> {
    if (!this.token) return;
    const response = await fetch(`${this.baseUrl}/api/internal/matter/devices`, { headers: { 'x-homehub-internal-token': this.token } });
    if (!response.ok) throw new Error(`HomeHub returned HTTP ${response.status}`);
    const devices = await response.json() as Device[];
    for (const device of devices) {
      if (this.registered.has(device.id)) continue;
      await this.registerHomeHubDevice(device);
    }
  }

  private async registerHomeHubDevice(device: Device): Promise<void> {
    const endpointType = device.matterType === 'light' ? onOffLight : onOffPlugInUnit;
    const endpoint = new MatterbridgeEndpoint(endpointType, { id: `homehub-${device.id}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        device.name,
        device.id,
        this.matterbridge.aggregatorVendorId,
        'QnapHomeHub',
        device.deviceType || 'SwitchBot',
        10000,
        '0.1.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusters();

    endpoint.addCommandHandler('on', () => {
      void this.action(device, device.mode === 'press' ? 'press' : 'on', endpoint);
    });
    endpoint.addCommandHandler('off', () => {
      if (device.mode === 'switch') void this.action(device, 'off', endpoint);
      else void endpoint.setAttribute(OnOff, 'onOff', false, this.log);
    });

    await this.registerDevice(endpoint);
    this.registered.add(device.id);
    this.log.info(`Registered ${device.name} (${device.id}) as ${device.matterType}`);
  }

  private async action(device: Device, action: 'press'|'on'|'off', endpoint: MatterbridgeEndpoint): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/devices/${encodeURIComponent(device.id)}/${action}`, {
        method: 'POST',
        headers: { 'x-homehub-internal-token': this.token, 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (device.mode === 'press') {
        await new Promise(resolve => setTimeout(resolve, 250));
        await endpoint.setAttribute(OnOff, 'onOff', false, this.log);
      }
    } catch (error) {
      this.log.error(`Command ${action} failed for ${device.name}: ${String(error)}`);
      if (device.mode === 'press') await endpoint.setAttribute(OnOff, 'onOff', false, this.log);
    }
  }
}
