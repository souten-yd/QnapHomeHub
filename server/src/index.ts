import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { AuthManager } from './auth.js';
import { ConfigStore, readSecret } from './config.js';
import { DebugEventStore } from './debug-events.js';
import { uniqueDeviceName } from './device-names.js';
import { diagnostics } from './diagnostics.js';
import { SwitchBotManager } from './switchbot-manager.js';
import type { RegisteredDevice } from './types.js';

type DeviceAction = 'press' | 'on' | 'off' | 'status' | 'power' | 'forceOff';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? '/data';
const port = Number(process.env.PORT ?? '8787');
const appVersion = process.env.HOMEHUB_VERSION ?? '0.1.0';
const updaterUrl = process.env.HOMEHUB_UPDATER_URL ?? 'http://127.0.0.1:8788';
const store = new ConfigStore(dataDir);
const debug = new DebugEventStore();
await store.load();

const [adminUsernameRaw, adminPassword, switchbotToken, switchbotSecret, internalToken, botPasswordsRaw] = await Promise.all([
  readSecret('HOMEHUB_ADMIN_USERNAME'),
  readSecret('HOMEHUB_ADMIN_PASSWORD'),
  readSecret('SWITCHBOT_TOKEN'),
  readSecret('SWITCHBOT_SECRET'),
  readSecret('HOMEHUB_INTERNAL_TOKEN'),
  readSecret('SWITCHBOT_BOT_PASSWORDS'),
]);
const adminUsername = adminUsernameRaw || 'admin';

let botPasswords: Record<string, string> = {};
if (botPasswordsRaw) {
  try { botPasswords = JSON.parse(botPasswordsRaw) as Record<string, string>; }
  catch {
    console.warn('SWITCHBOT_BOT_PASSWORDS is not valid JSON; ignoring it');
    debug.add('warn', 'config', 'SWITCHBOT_BOT_PASSWORDS is not valid JSON; ignoring it');
  }
}

const auth = new AuthManager(adminUsername, adminPassword);
const switchbot = new SwitchBotManager(
  () => store.get(),
  switchbotToken,
  switchbotSecret,
  (level, source, message, details) => debug.add(level, source, message, details),
);
const app = express();

let matterStatus: {
  state: string;
  lastSeenAt?: string;
  deviceCount?: number;
  error?: string;
} = { state: 'not-seen' };
let matterStatusSignature = '';

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function botPasswordFor(id: string): string | undefined {
  const registered = store.get().devices.find(device => device.id === id);
  return botPasswords[id] ?? botPasswords[(registered?.mac ?? '').replaceAll(':', '').toUpperCase()];
}

function normalizedForceHoldSeconds(value: unknown, fallback = 10): number {
  const candidate = Number(value);
  return Math.min(30, Math.max(3, Number.isFinite(candidate) ? candidate : fallback));
}

async function matterbridgeHealth(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch('http://127.0.0.1:8283/health', { signal: AbortSignal.timeout(1500) });
    const text = await response.text();
    return { reachable: true, status: response.status, body: text.slice(0, 500) };
  } catch (error) {
    return { reachable: false, error: (error as Error).message };
  }
}

async function updaterRequest(endpoint: string, init: RequestInit = {}): Promise<unknown> {
  if (!internalToken) throw new Error('Internal token is not configured');
  const response = await fetch(`${updaterUrl}${endpoint}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-homehub-internal-token': internalToken,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(endpoint === '/status' ? 2500 : 15000),
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { error: text }; }
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error?: unknown }).error) : `Updater HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function runDeviceCommand(
  id: string,
  action: DeviceAction,
  source: 'web' | 'matterbridge',
): Promise<unknown> {
  const registered = store.get().devices.find(device => device.id === id);
  const forceHoldSeconds = normalizedForceHoldSeconds(registered?.forceHoldSeconds, 10);
  debug.add('info', `api.${source}`, 'Command HTTP request received', { id, action, forceHoldSeconds });
  try {
    const result = await switchbot.command(id, action, botPasswordFor(id), forceHoldSeconds);
    const failed = Boolean(result && typeof result === 'object' && 'success' in result && (result as { success?: unknown }).success === false);
    debug.add(failed ? 'error' : 'info', `api.${source}`, failed ? 'Command HTTP request completed with failure' : 'Command HTTP request completed', {
      id,
      action,
      result: result as Record<string, unknown>,
    });
    return result;
  } catch (error) {
    debug.add('error', `api.${source}`, 'Command HTTP request failed', { id, action, error: (error as Error).message });
    throw error;
  }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', authRequired: auth.required, version: appVersion }));
app.post('/api/auth/login', (req, res) => auth.login(req, res));
app.post('/api/auth/logout', (req, res) => auth.logout(req, res));

const internalAuth: express.RequestHandler = (req, res, next) => {
  if (!internalToken) return void res.status(503).json({ error: 'Internal token is not configured' });
  const candidate = req.header('x-homehub-internal-token') ?? '';
  const a = Buffer.from(candidate); const b = Buffer.from(internalToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return void res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/api/internal/matter/devices', internalAuth, (_req, res) => {
  res.json(store.get().devices.filter(device => device.exposeMatter));
});
app.post('/api/internal/matter/status', internalAuth, (req, res) => {
  const next = {
    state: String(req.body?.state || 'unknown').slice(0, 40),
    lastSeenAt: new Date().toISOString(),
    deviceCount: Number.isFinite(Number(req.body?.deviceCount)) ? Number(req.body.deviceCount) : undefined,
    error: req.body?.error ? String(req.body.error).slice(0, 1000) : undefined,
  };
  const signature = JSON.stringify([next.state, next.deviceCount, next.error]);
  matterStatus = next;
  if (signature !== matterStatusSignature) {
    matterStatusSignature = signature;
    debug.add(next.error ? 'error' : 'info', 'matterbridge', 'Matterbridge plugin status changed', next);
  }
  res.json({ ok: true });
});
app.post('/api/internal/devices/:id/:action', internalAuth, async (req, res) => {
  try {
    const id = routeParam(req.params.id);
    const action = routeParam(req.params.action) as 'press' | 'on' | 'off' | 'status';
    if (!['press', 'on', 'off', 'status'].includes(action)) return void res.status(400).json({ error: 'Unknown action' });
    res.json(await runDeviceCommand(id, action, 'matterbridge'));
  } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.use('/api', auth.middleware);

app.get('/api/update/status', async (_req, res) => {
  try { res.json(await updaterRequest('/status')); }
  catch (error) { res.status(503).json({ error: (error as Error).message, available: false }); }
});
app.post('/api/update/check', async (_req, res) => {
  try {
    debug.add('info', 'updater', 'GitHub Release check requested from Web UI');
    res.json(await updaterRequest('/check', { method: 'POST', body: '{}' }));
  } catch (error) {
    debug.add('error', 'updater', 'GitHub Release check failed', { error: (error as Error).message });
    res.status(503).json({ error: (error as Error).message });
  }
});
app.patch('/api/update/config', async (req, res) => {
  try {
    const body = JSON.stringify({ autoUpdate: Boolean(req.body?.autoUpdate) });
    const result = await updaterRequest('/config', { method: 'PATCH', body });
    debug.add('info', 'updater', 'Automatic update setting changed', { autoUpdate: Boolean(req.body?.autoUpdate) });
    res.json(result);
  } catch (error) { res.status(503).json({ error: (error as Error).message }); }
});
app.post('/api/update/apply', async (req, res) => {
  try {
    const body = JSON.stringify({ tag: req.body?.tag });
    const result = await updaterRequest('/apply', { method: 'POST', body });
    debug.add('warn', 'updater', 'Release update accepted; HomeHub may restart', { tag: req.body?.tag });
    res.status(202).json(result);
  } catch (error) {
    debug.add('error', 'updater', 'Release update request failed', { error: (error as Error).message });
    res.status(503).json({ error: (error as Error).message });
  }
});

app.get('/api/config', (_req, res) => {
  const config = store.get();
  res.json({ ...config, credentials: { switchbotApi: Boolean(switchbotToken && switchbotSecret), internalToken: Boolean(internalToken) } });
});
app.patch('/api/config', async (req, res) => {
  const patch: Partial<ReturnType<typeof store.get>> = {};
  if (req.body.hciDeviceId !== undefined) patch.hciDeviceId = Number(req.body.hciDeviceId);
  if (req.body.scanTimeoutMs !== undefined) patch.scanTimeoutMs = Number(req.body.scanTimeoutMs);
  if (req.body.apiFallback !== undefined) patch.apiFallback = Boolean(req.body.apiFallback);
  if (req.body.scanOnStartup !== undefined) patch.scanOnStartup = Boolean(req.body.scanOnStartup);
  const previous = store.get();
  const next = await store.update(patch);
  debug.add('info', 'config', 'Configuration updated', {
    hciDeviceId: next.hciDeviceId,
    scanTimeoutMs: next.scanTimeoutMs,
    apiFallback: next.apiFallback,
    scanOnStartup: next.scanOnStartup,
  });
  res.json({ ...next, restartRequired: previous.hciDeviceId !== next.hciDeviceId || previous.apiFallback !== next.apiFallback });
});
app.post('/api/scan', async (_req, res) => {
  try { res.json({ devices: await switchbot.scan() }); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.get('/api/discovered', (_req, res) => res.json({ devices: switchbot.listDiscovered() }));
app.get('/api/devices', (_req, res) => res.json({ devices: store.get().devices }));
app.post('/api/devices', async (req, res) => {
  const source = switchbot.listDiscovered().find(device => device.id === req.body.id);
  if (!source) return void res.status(400).json({ error: 'Device is not in the latest scan results' });
  const config = store.get();
  if (config.devices.some(device => device.id === source.id)) return void res.status(409).json({ error: 'Device already registered' });
  const requestedName = String(req.body.name || source.name || 'SwitchBot');
  const controlProfile = req.body.controlProfile === 'pc-power' ? 'pc-power' : 'standard';
  const device: RegisteredDevice = {
    id: source.id,
    name: uniqueDeviceName(requestedName, config.devices),
    deviceType: source.deviceType,
    mac: source.mac,
    mode: controlProfile === 'pc-power' ? 'press' : req.body.mode === 'switch' ? 'switch' : 'press',
    controlProfile,
    forceHoldSeconds: normalizedForceHoldSeconds(req.body.forceHoldSeconds, 10),
    exposeMatter: req.body.exposeMatter !== false,
    matterType: req.body.matterType === 'light' ? 'light' : 'outlet',
    createdAt: new Date().toISOString(),
  };
  await store.update({ devices: [...config.devices, device] });
  debug.add('info', 'device', 'Device registered', {
    id: device.id,
    name: device.name,
    mac: device.mac,
    mode: device.mode,
    controlProfile: device.controlProfile,
    forceHoldSeconds: device.forceHoldSeconds,
    exposeMatter: device.exposeMatter,
  });
  res.status(201).json(device);
});
app.patch('/api/devices/:id', async (req, res) => {
  const config = store.get();
  const id = routeParam(req.params.id);
  const index = config.devices.findIndex(device => device.id === id);
  if (index < 0) return void res.status(404).json({ error: 'Device not found' });
  const old = config.devices[index]!;
  const controlProfile = req.body.controlProfile === 'pc-power'
    ? 'pc-power'
    : req.body.controlProfile === 'standard'
      ? 'standard'
      : old.controlProfile ?? 'standard';
  const requestedMode = req.body.mode === 'switch' ? 'switch' : req.body.mode === 'press' ? 'press' : old.mode;
  const next: RegisteredDevice = {
    ...old,
    name: req.body.name !== undefined ? uniqueDeviceName(String(req.body.name), config.devices, old.id) : old.name,
    mode: controlProfile === 'pc-power' ? 'press' : requestedMode,
    controlProfile,
    forceHoldSeconds: normalizedForceHoldSeconds(req.body.forceHoldSeconds, old.forceHoldSeconds ?? 10),
    exposeMatter: req.body.exposeMatter !== undefined ? Boolean(req.body.exposeMatter) : old.exposeMatter,
    matterType: req.body.matterType === 'light' ? 'light' : req.body.matterType === 'outlet' ? 'outlet' : old.matterType,
  };
  const devices = [...config.devices]; devices[index] = next;
  await store.update({ devices });
  debug.add('info', 'device', 'Device configuration updated', {
    id: next.id,
    name: next.name,
    mode: next.mode,
    controlProfile: next.controlProfile,
    forceHoldSeconds: next.forceHoldSeconds,
    exposeMatter: next.exposeMatter,
    matterType: next.matterType,
  });
  res.json(next);
});
app.delete('/api/devices/:id', async (req, res) => {
  const config = store.get();
  const id = routeParam(req.params.id);
  await store.update({ devices: config.devices.filter(device => device.id !== id) });
  debug.add('info', 'device', 'Device removed', { id });
  res.status(204).end();
});
app.post('/api/devices/:id/:action', async (req, res) => {
  try {
    const id = routeParam(req.params.id);
    const action = routeParam(req.params.action) as DeviceAction;
    if (!['press', 'on', 'off', 'status', 'power', 'forceOff'].includes(action)) return void res.status(400).json({ error: 'Unknown action' });
    const registered = store.get().devices.find(device => device.id === id);
    if (!registered) return void res.status(404).json({ error: 'Device not found' });
    if ((action === 'power' || action === 'forceOff') && registered.controlProfile !== 'pc-power') {
      return void res.status(400).json({ error: 'PC power actions require the PC power control profile' });
    }
    res.json(await runDeviceCommand(id, action, 'web'));
  } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.get('/api/diagnostics', async (_req, res) => res.json(await diagnostics()));
app.get('/api/debug/status', async (req, res) => {
  const limit = Number(req.query.limit ?? 120);
  res.json({
    now: new Date().toISOString(),
    homehub: {
      version: appVersion,
      hciDeviceId: store.get().hciDeviceId,
      discoveredCount: switchbot.listDiscovered().length,
      registeredCount: store.get().devices.length,
      discovered: switchbot.listDiscovered(),
    },
    matterbridge: {
      ...matterStatus,
      http: await matterbridgeHealth(),
    },
    system: await diagnostics(),
    events: debug.list(limit),
  });
});
app.post('/api/debug/clear', (_req, res) => {
  debug.clear();
  debug.add('info', 'debug', 'Web debug event history cleared');
  res.json({ ok: true });
});
app.post('/api/system/restart', (_req, res) => {
  debug.add('warn', 'system', 'HomeHub restart requested from Web UI');
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 250).unref();
});

const publicDir = path.resolve(here, '../public');
app.use(express.static(publicDir));
app.use((_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`QnapHomeHub ${appVersion} listening on http://0.0.0.0:${port}`);
  debug.add('info', 'system', 'QnapHomeHub HTTP server is ready', { port, version: appVersion, hciDeviceId: store.get().hciDeviceId });
});
if (store.get().scanOnStartup) switchbot.scan().catch(error => debug.add('error', 'ble.scan', 'Startup scan failed', { error: (error as Error).message }));

const shutdown = async () => {
  debug.add('info', 'system', 'QnapHomeHub shutting down');
  server.close();
  await switchbot.cleanup().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
