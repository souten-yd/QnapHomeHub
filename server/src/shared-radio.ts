import { execFile, fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RadioArbiter } from './radio-arbiter.js';
import type { AppConfig, DiscoveredDevice } from './types.js';

type Action = 'press' | 'on' | 'off' | 'status' | 'power' | 'forceOff';
type Debug = (level: 'info' | 'warn' | 'error', source: string, message: string, details?: Record<string, unknown>) => void;
const here = path.dirname(fileURLToPath(import.meta.url));

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let deadline: NodeJS.Timeout;
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 2500);
    const done = () => { clearTimeout(killTimer); clearTimeout(deadline); resolve(); };
    child.once('exit', done);
    deadline = setTimeout(() => { child.removeListener('exit', done); clearTimeout(killTimer); reject(new Error('Bluetooth owner did not exit; refusing overlapping access')); }, 6000);
    child.kill('SIGTERM');
  });
}

export class SharedRadioManager {
  private rawWorker?: ChildProcess;
  private bluez?: ChildProcess;
  private pythonWorker?: ChildProcess;
  private socketServer?: http.Server;
  private discovered: DiscoveredDevice[] = [];
  private sequence = 0;
  readonly arbiter: RadioArbiter;

  constructor(private readonly getConfig: () => AppConfig, private readonly token: string,
    private readonly secret: string, private readonly debug?: Debug) {
    this.arbiter = new RadioArbiter({
      stopHomeHub: () => this.stopHomeHub(), stopBlueZ: () => this.stopBlueZ(),
      resumeSelfCare: () => this.startBlueZ(),
      homeHub: <T>(request: unknown) => this.callRaw<T>(request),
      selfCare: <T>(request: unknown) => this.callSelfCare<T>(request),
    });
  }

  async initialize(): Promise<void> { /* HCI opens only inside the serialized worker. */ }
  listDiscovered(): DiscoveredDevice[] { return structuredClone(this.discovered); }
  async scan(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    this.discovered = await this.arbiter.run('homehub', { action: 'scan', timeoutMs });
    return this.listDiscovered();
  }
  command(deviceId: string, command: Action, password?: string, holdSeconds = 10): Promise<unknown> {
    return this.arbiter.run('homehub', { action: 'command', deviceId, command, password, holdSeconds });
  }

  private async stopHomeHub(): Promise<void> {
    await stopProcess(this.rawWorker);
    this.rawWorker = undefined;
  }
  private async stopBlueZ(): Promise<void> {
    await stopProcess(this.bluez);
    this.bluez = undefined;
  }

  private async callRaw<T>(request: any): Promise<T> {
    if (!this.rawWorker || this.rawWorker.exitCode !== null || this.rawWorker.signalCode !== null) {
      const adapter = `hci${this.getConfig().hciDeviceId}`;
      if (!/^hci\d{1,2}$/.test(adapter)) throw new Error('Invalid HCI adapter');
      await new Promise<void>((resolve, reject) => execFile('/usr/bin/hciconfig', [adapter, 'up'], { timeout: 5000 }, error => error ? reject(error) : resolve()));
      this.rawWorker = fork(path.join(here, 'radio-worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      this.rawWorker.on('message', (message: any) => { if (message.debug) this.debug?.(...message.debug as Parameters<Debug>); });
    }
    const child = this.rawWorker;
    const id = ++this.sequence;
    try {
      return await new Promise<T>((resolve, reject) => {
        const finish = (error?: Error, value?: T) => { clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', exit); child.removeListener('error', fail); error ? reject(error) : resolve(value!); };
        const receive = (message: any) => { if (message.id === id) finish(message.error ? new Error(message.error) : undefined, message.result); };
        const exit = () => finish(new Error('SwitchBot Bluetooth worker exited'));
        const fail = (error: Error) => finish(error);
        const timer = setTimeout(() => finish(new Error('SwitchBot operation timed out')), 90000);
        child.on('message', receive); child.once('exit', exit); child.once('error', fail);
        child.send({ ...request, id, config: this.getConfig(), token: this.token, secret: this.secret }, error => { if (error) fail(error); });
      });
    } catch (error) { await this.stopHomeHub(); throw error; }
  }

  private async callSelfCare<T>(request: any): Promise<T> {
    if (!['scan', 'pair', 'sync'].includes(request?.action)) throw new Error('Unknown SelfCare Bluetooth operation');
    if (request.adapter !== `hci${this.getConfig().hciDeviceId}`) throw new Error('SelfCare adapter must match the HomeHub HCI setting');
    this.debug?.('info', 'radio', 'USB Bluetooth ownership transferred to SelfCare', { action: request.action, adapter: request.adapter });
    await this.startBlueZ();
    const child = spawn('/opt/ble/bin/python', ['/app/ble/ble_worker.py'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.pythonWorker = child;
    try {
      return await this.pythonResult<T>(child, request);
    } finally { await stopProcess(child); this.pythonWorker = undefined; }
  }

  private async startBlueZ(): Promise<void> {
    if (this.bluez && this.bluez.exitCode === null && this.bluez.signalCode === null) return;
    const bluez = spawn('/usr/libexec/bluetooth/bluetoothd', ['--nodetach'], { stdio: ['ignore', 'ignore', 'inherit'] });
    this.bluez = bluez;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { bluez.removeListener('error', failed); bluez.removeListener('exit', exited); resolve(); }, 1500);
      const failed = (e: Error) => { clearTimeout(timer); reject(e); };
      const exited = () => { clearTimeout(timer); reject(new Error('BlueZ failed to start; check the private D-Bus service')); };
      bluez.once('error', failed); bluez.once('exit', exited);
    });
  }

  private async pythonResult<T>(child: ReturnType<typeof spawn>, request: unknown): Promise<T> {
      return await new Promise<T>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Omron Bluetooth operation timed out')); }, 190000);
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 * 1024) { child.kill('SIGTERM'); clearTimeout(timer); reject(new Error('Bluetooth response too large')); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
          clearTimeout(timer);
          try { const value = JSON.parse(output); if (code || value.error) throw new Error(value.error || 'Bluetooth worker failed'); resolve(value); }
          catch (error) { reject(error); }
        });
        child.stdin!.on('error', error => { clearTimeout(timer); reject(error); });
        child.stdin!.end(JSON.stringify(request));
      });
  }

  async listen(socketPath = '/radio/ble.sock'): Promise<void> {
    await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await fs.rm(socketPath, { force: true });
    this.socketServer = http.createServer(async (req, res) => {
      const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      try {
        if (req.method === 'GET' && req.url === '/health') return reply(200, { mode: 'homehub', shared: true, preferredOwner: 'selfcare', bridge: true, bleak: true, dbus: true, ...this.arbiter.status(), adapter: `hci${this.getConfig().hciDeviceId}` });
        if (req.method !== 'POST' || !['/run', '/homehub'].includes(req.url ?? '')) return reply(404, { error: 'Unknown route' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Request too large'); }
        const request = JSON.parse(body);
        if (req.url === '/homehub') {
          if (request.action === 'scan') return reply(200, await this.scan(Math.min(60000, Math.max(3000, Number(request.timeoutMs) || this.getConfig().scanTimeoutMs))));
          if (request.action !== 'command' || typeof request.deviceId !== 'string' || !['press','on','off','status','power','forceOff'].includes(request.command)) throw new Error('Invalid HomeHub operation');
          return reply(200, await this.command(request.deviceId, request.command, request.password, Math.min(30, Math.max(3, Number(request.holdSeconds) || 10))));
        }
        reply(200, await this.arbiter.run('selfcare', request));
      } catch (error) { reply(400, { error: (error as Error).message }); }
    });
    await new Promise<void>((resolve, reject) => { this.socketServer!.once('error', reject); this.socketServer!.listen(socketPath, () => resolve()); });
    await fs.chmod(socketPath, 0o600);
  }

  async cleanup(): Promise<void> {
    this.socketServer?.close();
    await stopProcess(this.pythonWorker);
    await this.stopHomeHub();
    await this.stopBlueZ();
  }
}
