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

type HomeHubCommandResult = { success?: boolean; error?: string } & Record<string, unknown>;

async function readToken(): Promise<string> {
  const file = process.env.HOMEHUB_INTERNAL_TOKEN_FILE;
  if (file) return (await fs.readFile(file, 'utf8')).trim();
  return (process.env.HOMEHUB_INTERNAL_TOKEN ?? '').trim();
}

function deviceSignature(device: Device): string {
  return JSON.stringify([device.name, device.deviceType, device.mode, device.matterType]);
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: Config): QnapHomeHubPlatform {
  return new QnapHomeHubPlatform(matterbridge, log, config);
}

export class QnapHomeHubPlatform extends MatterbridgeDynamicPlatform {
  private readonly baseUrl = process.env.QNAP_HOME_HUB_URL ?? 'http://127.0.0.1:8787';
  private token = '';
  private timer?: NodeJS.Timeout;
  private registered = new Map<string, string>();
  private reconciling = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: Config) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion === 'function' && !this.verifyMatterbridgeVersion('3.10.0')) {
      throw new Error('QnapHomeHub requires Matterbridge >= 3.10.0');
    }
  }

  override async onStart(): Promise<void> {
    await this.ready;
    this.token = await readToken();
    if (!this.token) {
      this.log.error('HOMEHUB_INTERNAL_TOKEN is not configured');
      return;
    }
    await this.reportStatus('starting');
    try {
      await this.reconcile();
    } catch (error) {
      this.log.error(`Initial reconcile failed: ${String(error)}`);
      await this.reportStatus('error', 0, String(error));
    }
    this.timer = setInterval(() => void this.reconcile().catch(async error => {
      this.log.error(`Reconcile failed: ${String(error)}`);
      await this.reportStatus('error', this.registered.size, String(error));
    }), 15_000);
    this.timer.unref();
  }

  override async onShutdown(reason?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.reportStatus('stopping', this.registered.size).catch(() => undefined);
    await super.onShutdown(reason);
  }

  private async reconcile(): Promise<void> {
    if (!this.token || this.reconciling) return;
    this.reconciling = true;
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/matter/devices`, { headers: { 'x-homehub-internal-token': this.token } });
      if (!response.ok) throw new Error(`HomeHub returned HTTP ${response.status}`);
      const devices = await response.json() as Device[];
      const desiredIds = new Set(devices.map(device => device.id));

      for (const id of [...this.registered.keys()]) {
        if (!desiredIds.has(id)) await this.unregisterHomeHubDevice(id);
      }

      for (const device of devices) {
        const signature = deviceSignature(device);
        const current = this.registered.get(device.id);
        if (current === signature) continue;
        if (current !== undefined) await this.unregisterHomeHubDevice(device.id);
        await this.registerHomeHubDevice(device, signature);
      }
      await this.reportStatus('ready', this.registered.size);
    } finally {
      this.reconciling = false;
    }
  }

  private async unregisterHomeHubDevice(id: string): Promise<void> {
    const endpoint = this.getDeviceById(`homehub-${id}`);
    if (endpoint) {
      await this.unregisterDevice(endpoint);
      this.log.info(`Unregistered HomeHub device ${id}`);
    }
    this.registered.delete(id);
  }

  private async registerHomeHubDevice(device: Device, signature: string): Promise<void> {
    const endpointType = device.matterType === 'light' ? onOffLight : onOffPlugInUnit;
    const endpoint = new MatterbridgeEndpoint(endpointType, { id: `homehub-${device.id}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        device.name,
        device.id,
        this.matterbridge.aggregatorVendorId,
        'QnapHomeHub',
        device.deviceType || 'SwitchBot',
        20000,
        '0.2.0',
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
    this.registered.set(device.id, signature);
    this.log.info(`Registered ${device.name} (${device.id}) as ${device.matterType}`);
  }

  private async action(device: Device, action: 'press'|'on'|'off', endpoint: MatterbridgeEndpoint): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/devices/${encodeURIComponent(device.id)}/${action}`, {
        method: 'POST',
        headers: { 'x-homehub-internal-token': this.token, 'content-type': 'application/json' },
      });
      const text = await response.text();
      let payload: HomeHubCommandResult = {};
      if (text) {
        try { payload = JSON.parse(text) as HomeHubCommandResult; }
        catch { payload = { error: text }; }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.error ?? text}`);
      if (payload.success === false) throw new Error(payload.error || 'HomeHub returned success=false');
      if (device.mode === 'press') {
        await new Promise(resolve => setTimeout(resolve, 250));
        await endpoint.setAttribute(OnOff, 'onOff', false, this.log);
      }
    } catch (error) {
      this.log.error(`Command ${action} failed for ${device.name}: ${String(error)}`);
      await this.reportStatus('command-error', this.registered.size, `${device.name}: ${String(error)}`).catch(() => undefined);
      if (device.mode === 'press') await endpoint.setAttribute(OnOff, 'onOff', false, this.log);
    }
  }

  private async reportStatus(state: string, deviceCount = this.registered.size, error?: string): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(`${this.baseUrl}/api/internal/matter/status`, {
        method: 'POST',
        headers: { 'x-homehub-internal-token': this.token, 'content-type': 'application/json' },
        body: JSON.stringify({ state, deviceCount, error }),
      });
    } catch (reportError) {
      this.log.warn(`Unable to report status to HomeHub: ${String(reportError)}`);
    }
  }
}
