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
  return Math.min(30, Math.max(3, Math.round(Number.isFinite(candidate) ? candidate : fallback)));
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
  const left = Buffer.from(candidate);
  const right = Buffer.from(internalToken);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const sessionAuth: express.RequestHandler = (req, res, next) => {
  if (!auth.required) return next();
  if (!auth.authorized(req)) return void res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/api/config', sessionAuth, (_req, res) => res.json(store.get()));
app.patch('/api/config', sessionAuth, async (req, res) => {
  const patch = {
    hciDeviceId: req.body.hciDeviceId,
    scanTimeoutMs: req.body.scanTimeoutMs,
    apiFallback: req.body.apiFallback,
    scanOnStartup: req.body.scanOnStartup,
  };
  const current = store.get();
  const next = await store.update({ ...current, ...patch });
  res.json({ ...next, restartRequired: current.hciDeviceId !== next.hciDeviceId || current.apiFallback !== next.apiFallback });
});

app.post('/api/scan', sessionAuth, async (_req, res) => {
  try { res.json({ devices: await switchbot.scan() }); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.get('/api/devices', sessionAuth, (_req, res) => res.json({ devices: store.get().devices }));
app.post('/api/devices', sessionAuth, async (req, res) => {
  const discovered = switchbot.listDiscovered();
  const source = discovered.find(device => device.id === req.body.id);
  if (!source) return void res.status(400).json({ error: 'Device is not in the latest discovery result' });
  const controlProfile = req.body.controlProfile === 'pc-power' ? 'pc-power' : 'standard';
  const requestedName = String(req.body.name || source.name || source.deviceType || 'SwitchBot').trim();
  const device: RegisteredDevice = {
    id: source.id,
    name: uniqueDeviceName(store.get().devices, requestedName || 'SwitchBot'),
    deviceType: source.deviceType,
    mac: source.mac,
    mode: controlProfile === 'pc-power' ? 'press' : req.body.mode === 'switch' ? 'switch' : 'press',
    controlProfile,
    forceHoldSeconds: normalizedForceHoldSeconds(req.body.forceHoldSeconds, 10),
    exposeMatter: req.body.exposeMatter !== false,
    matterType: req.body.matterType === 'light' ? 'light' : 'outlet',
    createdAt: new Date().toISOString(),
  };
  const devices = [...store.get().devices.filter(existing => existing.id !== device.id), device];
  await store.update({ devices });
  res.status(201).json(device);
});

app.patch('/api/devices/:id', sessionAuth, async (req, res) => {
  const id = routeParam(req.params.id);
  const devices = store.get().devices;
  const index = devices.findIndex(device => device.id === id);
  if (index < 0) return void res.status(404).json({ error: 'Device not found' });
  const current = devices[index];
  if (!current) return void res.status(404).json({ error: 'Device not found' });
  const controlProfile = req.body.controlProfile === 'pc-power'
    ? 'pc-power'
    : req.body.controlProfile === 'standard'
      ? 'standard'
      : (current.controlProfile ?? 'standard');
  const next: RegisteredDevice = {
    ...current,
    ...(typeof req.body.name === 'string' ? { name: uniqueDeviceName(devices, req.body.name.trim() || current.name, current.id) } : {}),
    ...(typeof req.body.mode === 'string' ? { mode: controlProfile === 'pc-power' ? 'press' : req.body.mode === 'switch' ? 'switch' : 'press' } : {}),
    ...(typeof req.body.controlProfile === 'string' ? { controlProfile } : {}),
    ...(req.body.forceHoldSeconds !== undefined ? { forceHoldSeconds: normalizedForceHoldSeconds(req.body.forceHoldSeconds, current.forceHoldSeconds ?? 10) } : {}),
    ...(typeof req.body.exposeMatter === 'boolean' ? { exposeMatter: req.body.exposeMatter } : {}),
    ...(req.body.matterType === 'outlet' || req.body.matterType === 'light' ? { matterType: req.body.matterType } : {}),
  };
  devices[index] = next;
  await store.update({ devices });
  res.json(next);
});

app.delete('/api/devices/:id', sessionAuth, async (req, res) => {
  const id = routeParam(req.params.id);
  await store.update({ devices: store.get().devices.filter(device => device.id !== id) });
  res.status(204).end();
});

app.post('/api/devices/:id/:action', sessionAuth, async (req, res) => {
  const id = routeParam(req.params.id);
  const action = routeParam(req.params.action) as DeviceAction;
  if (!['press', 'on', 'off', 'status', 'power', 'forceOff'].includes(action)) {
    return void res.status(400).json({ error: 'Unknown action' });
  }
  if (action === 'forceOff' && req.header('x-confirm-force-off') !== 'confirmed') {
    return void res.status(428).json({ error: 'Force-off requires explicit confirmation' });
  }
  try { res.json(await runDeviceCommand(id, action, 'web')); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.post('/api/internal/devices/:id/:action', internalAuth, async (req, res) => {
  const id = routeParam(req.params.id);
  const action = routeParam(req.params.action) as DeviceAction;
  if (!['press', 'on', 'off', 'status', 'power', 'forceOff'].includes(action)) {
    return void res.status(400).json({ error: 'Unknown action' });
  }
  try { res.json(await runDeviceCommand(id, action, 'matterbridge')); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.get('/api/debug/status', sessionAuth, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
  res.json({
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

app.post('/api/debug/clear', sessionAuth, (_req, res) => {
  debug.clear();
  res.json({ success: true });
});

app.get('/api/updater/status', sessionAuth, async (_req, res) => {
  try { res.json(await updaterRequest('/status')); }
  catch (error) { res.status(503).json({ error: (error as Error).message }); }
});
app.post('/api/updater/check', sessionAuth, async (_req, res) => {
  try { res.json(await updaterRequest('/check', { method: 'POST' })); }
  catch (error) { res.status(503).json({ error: (error as Error).message }); }
});
app.patch('/api/updater/config', sessionAuth, async (req, res) => {
  try { res.json(await updaterRequest('/config', { method: 'PATCH', body: JSON.stringify(req.body ?? {}) })); }
  catch (error) { res.status(503).json({ error: (error as Error).message }); }
});
app.post('/api/updater/apply', sessionAuth, async (req, res) => {
  try { res.status(202).json(await updaterRequest('/apply', { method: 'POST', body: JSON.stringify(req.body ?? {}) })); }
  catch (error) { res.status(503).json({ error: (error as Error).message }); }
});

app.post('/api/internal/matterbridge/status', internalAuth, (req, res) => {
  matterStatus = {
    state: String(req.body.state || 'unknown'),
    lastSeenAt: new Date().toISOString(),
    deviceCount: Number.isFinite(Number(req.body.deviceCount)) ? Number(req.body.deviceCount) : undefined,
    error: req.body.error ? String(req.body.error) : undefined,
  };
  const signature = JSON.stringify([matterStatus.state, matterStatus.deviceCount, matterStatus.error]);
  if (signature !== matterStatusSignature || matterStatus.state === 'error') {
    debug.add(matterStatus.state === 'error' ? 'error' : 'info', 'matterbridge', 'Matterbridge plugin status changed', matterStatus as Record<string, unknown>);
    matterStatusSignature = signature;
  }
  res.json({ success: true });
});

app.post('/api/system/restart', sessionAuth, async (_req, res) => {
  if (!internalToken) return void res.status(503).json({ error: 'Internal token is not configured' });
  try {
    await updaterRequest('/restart-homehub', { method: 'POST' });
    res.status(202).json({ success: true });
  } catch (error) {
    res.status(503).json({ error: (error as Error).message });
  }
});

app.use(express.static(path.resolve(here, '../public')));
app.get('/{*splat}', (_req, res) => res.sendFile(path.resolve(here, '../public/index.html')));

await switchbot.initialize();
if (store.get().scanOnStartup) switchbot.scan().catch(error => debug.add('error', 'startup', 'Startup BLE scan failed', { error: (error as Error).message }));

const server = app.listen(port, '0.0.0.0', () => console.log(`QnapHomeHub listening on :${port}`));

async function shutdown(): Promise<void> {
  server.close();
  await switchbot.cleanup();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
