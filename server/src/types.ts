export type BotMode = 'press' | 'switch';
export type MatterType = 'outlet' | 'light';

export interface RegisteredDevice {
  id: string;
  name: string;
  deviceType: string;
  mac?: string;
  mode: BotMode;
  exposeMatter: boolean;
  matterType: MatterType;
  createdAt: string;
}

export interface AppConfig {
  hciDeviceId: number;
  scanTimeoutMs: number;
  apiFallback: boolean;
  scanOnStartup: boolean;
  devices: RegisteredDevice[];
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  deviceType: string;
  mac?: string;
  battery?: number;
  rssi?: number;
  connectionTypes: string[];
}
