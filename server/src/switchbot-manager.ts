import type { AppConfig, DiscoveredDevice } from './types.js';
import { SerialQueue } from './queue.js';

export class SwitchBotManager {
  private client: any;
  private initialized = false;
  private discovered = new Map<string, any>();
  private readonly queue = new SerialQueue();

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly token: string,
    private readonly secret: string,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const config = this.getConfig();
    process.env.NOBLE_HCI_DEVICE_ID = String(config.hciDeviceId);
    const module = await import('node-switchbot');
    this.client = new module.SwitchBot({
      token: this.token,
      secret: this.secret,
      enableBLE: true,
      enableFallback: config.apiFallback && Boolean(this.token && this.secret),
      enableConnectionIntelligence: false,
      enableCircuitBreaker: true,
      enableRetry: true,
      logLevel: 3,
    });
    this.initialized = true;
  }

  async scan(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    return this.queue.run(() => this.scanUnlocked(timeoutMs));
  }

  private async scanUnlocked(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    await this.initialize();
    const config = this.getConfig();
    const devices = await this.client.discover({
      scanBLE: true,
      fetchAPI: config.apiFallback && Boolean(this.token && this.secret),
      timeout: timeoutMs ?? config.scanTimeoutMs,
    });
    this.discovered.clear();
    for (const device of devices as any[]) {
      const info = device.getInfo();
      this.discovered.set(info.id, device);
    }
    return this.listDiscovered();
  }

  listDiscovered(): DiscoveredDevice[] {
    return [...this.discovered.values()].map(device => {
      const info = device.getInfo();
      return {
        id: info.id,
        name: info.name,
        deviceType: info.deviceType,
        mac: info.mac,
        battery: info.battery,
        rssi: info.rssi,
        connectionTypes: info.connectionTypes ?? [],
      };
    });
  }

  async command(id: string, action: 'press' | 'on' | 'off' | 'status', botPassword?: string): Promise<unknown> {
    return this.queue.run(async () => {
      const device = await this.ensureDevice(id);
      if (!device) throw new Error(`Device ${id} was not found. Run a Bluetooth scan first.`);
      if (botPassword && typeof device.setPassword === 'function') device.setPassword(botPassword);
      switch (action) {
        case 'press':
          if (typeof device.press !== 'function') throw new Error('Device does not support press');
          return { success: await device.press() };
        case 'on':
          if (typeof device.turnOn !== 'function') throw new Error('Device does not support turnOn');
          return { success: await device.turnOn() };
        case 'off':
          if (typeof device.turnOff !== 'function') throw new Error('Device does not support turnOff');
          return { success: await device.turnOff() };
        case 'status':
          if (typeof device.getStatus !== 'function') throw new Error('Device does not support status');
          return await device.getStatus();
      }
    });
  }

  async cleanup(): Promise<void> {
    if (this.client?.cleanup) await this.client.cleanup();
  }

  private async ensureDevice(id: string): Promise<any | undefined> {
    await this.initialize();
    let device = this.discovered.get(id) ?? this.client.devices?.get(id);
    if (device) return device;
    await this.scanUnlocked(Math.min(this.getConfig().scanTimeoutMs, 8_000));
    device = this.discovered.get(id) ?? this.client.devices?.get(id);
    return device;
  }
}
