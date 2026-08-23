import type { AppConfig, DiscoveredDevice } from './types.js';
import { SerialQueue } from './queue.js';

type DebugSink = (
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  details?: Record<string, unknown>,
) => void;

export class SwitchBotManager {
  private client: any;
  private initialized = false;
  private discovered = new Map<string, any>();
  private readonly queue = new SerialQueue();

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly token: string,
    private readonly secret: string,
    private readonly debug?: DebugSink,
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
    this.emit('info', 'ble', 'SwitchBot BLE client initialized', { hciDeviceId: config.hciDeviceId });
  }

  async scan(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    return this.queue.run(() => this.scanUnlocked(timeoutMs));
  }

  private async scanUnlocked(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    await this.initialize();
    const config = this.getConfig();
    const timeout = timeoutMs ?? config.scanTimeoutMs;
    this.emit('info', 'ble.scan', 'BLE scan started', { timeoutMs: timeout });
    try {
      const devices = await this.client.discover({
        scanBLE: true,
        fetchAPI: config.apiFallback && Boolean(this.token && this.secret),
        timeout,
      });
      this.discovered.clear();
      for (const device of devices as any[]) {
        const info = device.getInfo();
        this.discovered.set(info.id, device);
      }
      const result = this.listDiscovered();
      this.emit('info', 'ble.scan', 'BLE scan completed', {
        count: result.length,
        devices: result.map(device => ({ id: device.id, name: device.name, mac: device.mac, rssi: device.rssi })),
      });
      return result;
    } catch (error) {
      this.emit('error', 'ble.scan', 'BLE scan failed', { error: this.errorMessage(error) });
      throw error;
    }
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
    this.emit('info', 'command', 'Device command requested', { id, action });
    return this.queue.run(async () => {
      let device: any;
      try {
        device = await this.ensureDevice(id);
        if (!device) throw new Error(`Device ${id} was not found. Run a Bluetooth scan first.`);
        if (botPassword && typeof device.setPassword === 'function') device.setPassword(botPassword);

        const snapshot = this.deviceSnapshot(device);
        this.emit('info', 'command', 'Executing device command', { id, action, ...snapshot });

        if (action === 'status') {
          if (typeof device.getStatus !== 'function') throw new Error('Device does not support status');
          const status = await device.getStatus();
          this.emit('info', 'command', 'Device status read succeeded', { id, action, ...this.deviceSnapshot(device) });
          return status;
        }

        let capturedError: unknown;
        const errorListener = (payload: unknown) => { capturedError = payload; };
        if (typeof device.on === 'function') device.on('error', errorListener);
        try {
          let success = false;
          if (action === 'press') {
            if (typeof device.press !== 'function') throw new Error('Device does not support press');
            success = Boolean(await device.press());
          } else if (action === 'on') {
            if (typeof device.turnOn !== 'function') throw new Error('Device does not support turnOn');
            success = Boolean(await device.turnOn());
          } else {
            if (typeof device.turnOff !== 'function') throw new Error('Device does not support turnOff');
            success = Boolean(await device.turnOff());
          }

          const after = this.deviceSnapshot(device);
          const error = success ? undefined : this.errorMessage(capturedError) || this.failureHint(after);
          const result = {
            success,
            action,
            deviceId: id,
            connectionType: after.activeConnection,
            ...(error ? { error } : {}),
            device: after,
          };
          this.emit(success ? 'info' : 'error', 'command', success ? 'Device command succeeded' : 'Device command failed', result);
          return result;
        } finally {
          if (typeof device.off === 'function') device.off('error', errorListener);
        }
      } catch (error) {
        this.emit('error', 'command', 'Device command threw an error', {
          id,
          action,
          error: this.errorMessage(error),
          ...(device ? this.deviceSnapshot(device) : {}),
        });
        throw error;
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
    this.emit('warn', 'command', 'Device was not cached; running a short BLE scan', { id });
    await this.scanUnlocked(Math.min(this.getConfig().scanTimeoutMs, 8_000));
    device = this.discovered.get(id) ?? this.client.devices?.get(id);
    return device;
  }

  private deviceSnapshot(device: any): Record<string, unknown> {
    const info = typeof device?.getInfo === 'function' ? device.getInfo() : {};
    return {
      id: info?.id,
      mac: info?.mac,
      deviceType: info?.deviceType,
      connectionTypes: info?.connectionTypes ?? [],
      activeConnection: info?.activeConnection,
      hasBLE: typeof device?.hasBLE === 'function' ? Boolean(device.hasBLE()) : undefined,
      hasAPI: typeof device?.hasAPI === 'function' ? Boolean(device.hasAPI()) : undefined,
    };
  }

  private failureHint(snapshot: Record<string, unknown>): string {
    if (snapshot.hasBLE === false) return 'BLE is not available for this discovered device';
    return 'SwitchBot BLE command returned false without an error detail';
  }

  private errorMessage(value: unknown): string {
    if (!value) return '';
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const candidate = value as { error?: unknown; message?: unknown };
      const nested = this.errorMessage(candidate.error);
      if (nested) return nested;
      if (typeof candidate.message === 'string') return candidate.message;
    }
    try { return JSON.stringify(value); }
    catch { return String(value); }
  }

  private emit(level: 'info' | 'warn' | 'error', source: string, message: string, details?: Record<string, unknown>): void {
    this.debug?.(level, source, message, details);
  }
}
