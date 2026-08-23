import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { AuthManager } from './auth.js';
import { ConfigStore, readSecret } from './config.js';
import { uniqueDeviceName } from './device-names.js';
import { diagnostics } from './diagnostics.js';
import { SwitchBotManager } from './switchbot-manager.js';
import type { RegisteredDevice } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? '/data';
const port = Number(process.env.PORT ?? '8787');
const store = new ConfigStore(dataDir);
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
  catch { console.warn('SWITCHBOT_BOT_PASSWORDS is not valid JSON; ignoring it'); }
}

const auth = new AuthManager(adminUsername, adminPassword);
const switchbot = new SwitchBotManager(() => store.get(), switchbotToken, switchbotSecret);
const app = express();

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', authRequired: auth.required, version: '0.1.0' }));
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
app.post('/api/internal/devices/:id/:action', internalAuth, async (req, res) => {
  try {
    const id = routeParam(req.params.id);
    const action = routeParam(req.params.action) as 'press' | 'on' | 'off' | 'status';
    if (!['press', 'on', 'off', 'status'].includes(action)) return void res.status(400).json({ error: 'Unknown action' });
    const registered = store.get().devices.find(device => device.id === id);
    const password = botPasswords[id] ?? botPasswords[(registered?.mac ?? '').replaceAll(':', '').toUpperCase()];
    res.json(await switchbot.command(id, action, password));
  } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.use('/api', auth.middleware);
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
  const device: RegisteredDevice = {
    id: source.id,
    name: uniqueDeviceName(requestedName, config.devices),
    deviceType: source.deviceType,
    mac: source.mac,
    mode: req.body.mode === 'switch' ? 'switch' : 'press',
    exposeMatter: req.body.exposeMatter !== false,
    matterType: req.body.matterType === 'light' ? 'light' : 'outlet',
    createdAt: new Date().toISOString(),
  };
  await store.update({ devices: [...config.devices, device] });
  res.status(201).json(device);
});
app.patch('/api/devices/:id', async (req, res) => {
  const config = store.get();
  const id = routeParam(req.params.id);
  const index = config.devices.findIndex(device => device.id === id);
  if (index < 0) return void res.status(404).json({ error: 'Device not found' });
  const old = config.devices[index]!;
  const next: RegisteredDevice = {
    ...old,
    name: req.body.name !== undefined ? uniqueDeviceName(String(req.body.name), config.devices, old.id) : old.name,
    mode: req.body.mode === 'switch' ? 'switch' : req.body.mode === 'press' ? 'press' : old.mode,
    exposeMatter: req.body.exposeMatter !== undefined ? Boolean(req.body.exposeMatter) : old.exposeMatter,
    matterType: req.body.matterType === 'light' ? 'light' : req.body.matterType === 'outlet' ? 'outlet' : old.matterType,
  };
  const devices = [...config.devices]; devices[index] = next;
  await store.update({ devices });
  res.json(next);
});
app.delete('/api/devices/:id', async (req, res) => {
  const config = store.get();
  const id = routeParam(req.params.id);
  await store.update({ devices: config.devices.filter(device => device.id !== id) });
  res.status(204).end();
});
app.post('/api/devices/:id/:action', async (req, res) => {
  try {
    const id = routeParam(req.params.id);
    const action = routeParam(req.params.action) as 'press' | 'on' | 'off' | 'status';
    if (!['press', 'on', 'off', 'status'].includes(action)) return void res.status(400).json({ error: 'Unknown action' });
    const registered = store.get().devices.find(device => device.id === id);
    const password = botPasswords[id] ?? botPasswords[(registered?.mac ?? '').replaceAll(':', '').toUpperCase()];
    res.json(await switchbot.command(id, action, password));
  } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.get('/api/diagnostics', async (_req, res) => res.json(await diagnostics()));
app.post('/api/system/restart', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 250).unref();
});

const publicDir = path.resolve(here, '../public');
app.use(express.static(publicDir));
app.use((_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = app.listen(port, '0.0.0.0', () => console.log(`QnapHomeHub listening on http://0.0.0.0:${port}`));
if (store.get().scanOnStartup) switchbot.scan().catch(error => console.warn('Startup scan failed:', error));

const shutdown = async () => {
  server.close();
  await switchbot.cleanup().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
