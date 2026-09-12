import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const bind = process.env.UPDATER_BIND || '127.0.0.1';
const port = Number(process.env.UPDATER_PORT || '8788');
const dataDir = process.env.DATA_DIR || '/data';
const projectDir = process.env.PROJECT_DIR || '/share/Container/QnapHomeHub';
const composeProject = process.env.COMPOSE_PROJECT_NAME || 'qnaphomehub';
const repository = process.env.GITHUB_REPOSITORY || 'souten-yd/QnapHomeHub';
const image = process.env.GHCR_IMAGE || 'ghcr.io/souten-yd/qnaphomehub';
const checkIntervalMs = Math.max(60 * 60 * 1000, Number(process.env.UPDATE_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000));
const configFile = path.join(dataDir, 'config.json');
const stateFile = path.join(dataDir, 'state.json');
const testedMatterbridgeRef = `${image}:matterbridge-tested`;

async function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFile(file, 'utf8').then(value => value.trim()).catch(() => '');
  return (process.env[name] || '').trim();
}

const internalToken = await readSecret('HOMEHUB_INTERNAL_TOKEN');
let config = { autoUpdate: false };
let state = {
  phase: 'idle',
  currentVersion: null,
  latestVersion: null,
  latestTag: null,
  updateAvailable: false,
  lastCheckedAt: null,
  lastAppliedAt: null,
  lastError: null,
  releaseUrl: null,
  releaseName: null,
  matterbridge: {
    phase: 'idle',
    currentVersion: null,
    testedVersion: null,
    updateAvailable: false,
    currentImageId: null,
    testedImageId: null,
    lastCheckedAt: null,
    lastAppliedAt: null,
    lastError: null,
  },
};
let busy = false;

async function loadJson(file, fallback) {
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      ...fallback,
      ...saved,
      matterbridge: { ...fallback.matterbridge, ...(saved.matterbridge || {}) },
    };
  } catch { return structuredClone(fallback); }
}

async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

config = await loadJson(configFile, config);
state = await loadJson(stateFile, state);

function log(message, details) {
  if (details === undefined) console.log(`[Updater] ${message}`);
  else console.log(`[Updater] ${message}`, details);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function semverParts(value) {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const left = semverParts(a); const right = semverParts(b);
  if (!left || !right) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function command(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { ...options, env: { ...process.env, ...(options.env || {}) } });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; process.stdout.write(`[Updater] ${chunk}`); });
    child.stderr?.on('data', chunk => { stderr += chunk; process.stderr.write(`[Updater] ${chunk}`); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${args.join(' ')} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function currentVersion() {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return state.currentVersion;
    const body = await response.json();
    return normalizeVersion(body.version) || state.currentVersion;
  } catch { return state.currentVersion; }
}

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'QnapHomeHub-Updater' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub Releases returned HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error('Latest GitHub release is not a stable release');
  if (!/^v\d+\.\d+\.\d+$/.test(String(release.tag_name || ''))) throw new Error(`Unsupported release tag: ${release.tag_name}`);
  return release;
}

async function imageId(container) {
  return command(['docker', 'inspect', '--format', '{{.Image}}', container]);
}

async function imageRefId(ref) {
  return command(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref]);
}

async function containerImageVersion(container) {
  try {
    return normalizeVersion(await command(['docker', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.version" }}', container]));
  } catch { return null; }
}

async function imageVersion(ref) {
  try {
    return normalizeVersion(await command(['docker', 'image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.version" }}', ref]));
  } catch { return null; }
}

async function composeUp(services) {
  await command([
    'docker', 'compose', '-p', composeProject,
    '--project-directory', projectDir,
    '-f', path.join(projectDir, 'compose.yaml'),
    'up', '-d', '--force-recreate', ...services,
  ]);
}

async function waitForHealthy(targetVersion, { requireHomeHub = true, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'waiting';
  while (Date.now() < deadline) {
    try {
      const matter = await fetch('http://127.0.0.1:8283/health', { signal: AbortSignal.timeout(2500) });
      if (!requireHomeHub) {
        if (matter.ok) return;
        last = `matter=${matter.status}`;
      } else {
        const home = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(2500) });
        const homeBody = home.ok ? await home.json() : {};
        if (home.ok && matter.ok && (!targetVersion || normalizeVersion(homeBody.version) === normalizeVersion(targetVersion))) return;
        last = `home=${home.status}/${homeBody.version || '-'} matter=${matter.status}`;
      }
    } catch (error) { last = error.message; }
    await delay(2000);
  }
  throw new Error(`Health check timed out: ${last}`);
}

async function checkHomeHubRelease() {
  state.phase = 'checking';
  try {
    const release = await latestRelease();
    const current = await currentVersion();
    const latest = normalizeVersion(release.tag_name);
    Object.assign(state, {
      phase: 'idle',
      currentVersion: current,
      latestVersion: latest,
      latestTag: release.tag_name,
      updateAvailable: Boolean(current && compareVersions(latest, current) > 0),
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      releaseUrl: release.html_url || null,
      releaseName: release.name || release.tag_name,
    });
    log('QnapHomeHub release check complete', { current, latest, updateAvailable: state.updateAvailable });
  } catch (error) {
    state.phase = 'error';
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = error.message;
    log('QnapHomeHub release check failed', error.message);
  }
}

async function checkTestedMatterbridge() {
  const matter = state.matterbridge;
  matter.phase = 'checking';
  matter.lastError = null;
  try {
    await command(['docker', 'pull', testedMatterbridgeRef]);
    const [currentImageId, testedImageId, currentMatterVersion, testedVersion] = await Promise.all([
      imageId('qnaphomehub-matterbridge'),
      imageRefId(testedMatterbridgeRef),
      containerImageVersion('qnaphomehub-matterbridge'),
      imageVersion(testedMatterbridgeRef),
    ]);
    Object.assign(matter, {
      phase: 'idle',
      currentVersion: currentMatterVersion,
      testedVersion,
      updateAvailable: currentImageId !== testedImageId,
      currentImageId,
      testedImageId,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    });
    log('Tested Matterbridge check complete', {
      currentVersion: currentMatterVersion,
      testedVersion,
      updateAvailable: matter.updateAvailable,
    });
  } catch (error) {
    matter.phase = 'error';
    matter.lastCheckedAt = new Date().toISOString();
    matter.lastError = error.message;
    log('Tested Matterbridge check failed', error.message);
  }
}

async function checkForUpdates({ triggerAuto = true } = {}) {
  if (busy) return statusPayload();
  await Promise.all([checkHomeHubRelease(), checkTestedMatterbridge()]);
  await saveJson(stateFile, state);

  if (triggerAuto && config.autoUpdate) {
    if (state.updateAvailable && state.latestTag) {
      setTimeout(() => void applyReleaseUpdate(state.latestTag, true), 250).unref();
    } else if (state.matterbridge.updateAvailable) {
      setTimeout(() => void applyTestedMatterbridge(true), 250).unref();
    }
  }
  return statusPayload();
}

async function applyReleaseUpdate(tag = state.latestTag, automatic = false) {
  if (busy) return;
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('No valid stable release is selected');
  busy = true;
  const version = normalizeVersion(tag);
  let oldServer; let oldMatter;
  try {
    state.phase = 'preparing'; state.lastError = null;
    await saveJson(stateFile, state);
    oldServer = await imageId('qnaphomehub');
    oldMatter = await imageId('qnaphomehub-matterbridge');
    log(`Starting ${automatic ? 'automatic' : 'manual'} QnapHomeHub update to ${tag}`, { oldServer, oldMatter });

    state.phase = 'pulling'; await saveJson(stateFile, state);
    const serverRelease = `${image}:server-${tag}`;
    const matterRelease = `${image}:matterbridge-${tag}`;
    const updaterRelease = `${image}:updater-${tag}`;
    await command(['docker', 'pull', serverRelease]);
    await command(['docker', 'pull', matterRelease]);
    await command(['docker', 'pull', updaterRelease]).catch(error => log('Updater image is not available for this release; keeping current updater', error.message));
    await command(['docker', 'tag', serverRelease, `${image}:server`]);
    await command(['docker', 'tag', matterRelease, `${image}:matterbridge`]);
    await command(['docker', 'image', 'inspect', updaterRelease]).then(() => command(['docker', 'tag', updaterRelease, `${image}:updater`])).catch(() => undefined);

    state.phase = 'recreating'; await saveJson(stateFile, state);
    await composeUp(['homehub', 'matterbridge']);
    state.phase = 'verifying'; await saveJson(stateFile, state);
    await waitForHealthy(version);
    await delay(5000);

    state.phase = 'success';
    state.currentVersion = version;
    state.updateAvailable = false;
    state.lastAppliedAt = new Date().toISOString();
    state.lastError = null;
    state.matterbridge.currentVersion = await containerImageVersion('qnaphomehub-matterbridge');
    state.matterbridge.currentImageId = await imageId('qnaphomehub-matterbridge');
    state.matterbridge.updateAvailable = state.matterbridge.testedImageId
      ? state.matterbridge.currentImageId !== state.matterbridge.testedImageId
      : false;
    await saveJson(stateFile, state);
    log(`QnapHomeHub update to ${tag} completed`);
  } catch (error) {
    log(`QnapHomeHub update to ${tag} failed; attempting rollback`, error.message);
    state.phase = 'rollback'; state.lastError = error.message;
    await saveJson(stateFile, state);
    try {
      if (oldServer) await command(['docker', 'tag', oldServer, `${image}:server`]);
      if (oldMatter) await command(['docker', 'tag', oldMatter, `${image}:matterbridge`]);
      if (oldServer && oldMatter) {
        await composeUp(['homehub', 'matterbridge']);
        await waitForHealthy(null, { timeoutMs: 90000 });
      }
      state.phase = 'error';
      state.currentVersion = await currentVersion();
      state.lastError = `${error.message} (rollback completed)`;
    } catch (rollbackError) {
      state.phase = 'error';
      state.lastError = `${error.message}; rollback also failed: ${rollbackError.message}`;
    }
    await saveJson(stateFile, state);
  } finally {
    busy = false;
  }
}

async function applyTestedMatterbridge(automatic = false) {
  if (busy) return;
  busy = true;
  const matter = state.matterbridge;
  let oldMatter;
  try {
    matter.phase = 'preparing'; matter.lastError = null;
    await saveJson(stateFile, state);
    oldMatter = await imageId('qnaphomehub-matterbridge');
    log(`Starting ${automatic ? 'automatic' : 'manual'} tested Matterbridge update`, { oldMatter });

    matter.phase = 'pulling'; await saveJson(stateFile, state);
    await command(['docker', 'pull', testedMatterbridgeRef]);
    const testedImageId = await imageRefId(testedMatterbridgeRef);
    const testedVersion = await imageVersion(testedMatterbridgeRef);
    await command(['docker', 'tag', testedMatterbridgeRef, `${image}:matterbridge`]);

    matter.phase = 'recreating'; await saveJson(stateFile, state);
    await composeUp(['matterbridge']);
    matter.phase = 'verifying'; await saveJson(stateFile, state);
    await waitForHealthy(null, { requireHomeHub: false, timeoutMs: 120000 });
    // The plugin reconciles every 15 seconds. Give it one complete cycle after health is green.
    await delay(18000);

    matter.phase = 'success';
    matter.currentVersion = await containerImageVersion('qnaphomehub-matterbridge');
    matter.testedVersion = testedVersion;
    matter.currentImageId = await imageId('qnaphomehub-matterbridge');
    matter.testedImageId = testedImageId;
    matter.updateAvailable = matter.currentImageId !== testedImageId;
    matter.lastAppliedAt = new Date().toISOString();
    matter.lastError = null;
    await saveJson(stateFile, state);
    log(`Tested Matterbridge ${testedVersion || ''} update completed`);
  } catch (error) {
    log('Tested Matterbridge update failed; attempting rollback', error.message);
    matter.phase = 'rollback'; matter.lastError = error.message;
    await saveJson(stateFile, state);
    try {
      if (oldMatter) {
        await command(['docker', 'tag', oldMatter, `${image}:matterbridge`]);
        await composeUp(['matterbridge']);
        await waitForHealthy(null, { requireHomeHub: false, timeoutMs: 90000 });
      }
      matter.phase = 'error';
      matter.currentVersion = await containerImageVersion('qnaphomehub-matterbridge');
      matter.currentImageId = await imageId('qnaphomehub-matterbridge');
      matter.lastError = `${error.message} (rollback completed)`;
    } catch (rollbackError) {
      matter.phase = 'error';
      matter.lastError = `${error.message}; rollback also failed: ${rollbackError.message}`;
    }
    await saveJson(stateFile, state);
  } finally {
    busy = false;
  }
}

function statusPayload() {
  return {
    ...state,
    busy,
    autoUpdate: Boolean(config.autoUpdate),
    checkIntervalMs,
    repository,
    testedMatterbridgeRef,
  };
}

function authorized(req) {
  if (!internalToken) return false;
  return req.headers['x-homehub-internal-token'] === internalToken;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if (raw.length > 32768) throw new Error('Request body too large');
  return JSON.parse(raw);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, statusPayload());
    if (req.method === 'POST' && req.url === '/check') return send(res, 200, await checkForUpdates({ triggerAuto: false }));
    if (req.method === 'PATCH' && req.url === '/config') {
      const body = await readBody(req);
      if (body.autoUpdate !== undefined) config.autoUpdate = Boolean(body.autoUpdate);
      await saveJson(configFile, config);
      log('Updater configuration changed', config);
      return send(res, 200, statusPayload());
    }
    if (req.method === 'POST' && req.url === '/apply') {
      if (busy) return send(res, 409, { error: 'Update already in progress', ...statusPayload() });
      const body = await readBody(req);
      const tag = body.tag || state.latestTag;
      if (tag === 'matterbridge-tested') {
        setTimeout(() => void applyTestedMatterbridge(false), 50).unref();
        return send(res, 202, { accepted: true, component: 'matterbridge', tag });
      }
      if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) return send(res, 400, { error: 'No valid release selected' });
      setTimeout(() => void applyReleaseUpdate(tag, false), 50).unref();
      return send(res, 202, { accepted: true, component: 'release', tag });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    log('HTTP request failed', error.message);
    return send(res, 500, { error: error.message });
  }
});

server.listen(port, bind, () => log(`Updater listening on http://${bind}:${port}`));

setTimeout(() => void checkForUpdates().catch(error => log('Initial update check failed', error.message)), 15000).unref();
setInterval(() => void checkForUpdates().catch(error => log('Scheduled update check failed', error.message)), checkIntervalMs).unref();

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
