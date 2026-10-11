/** Explicit, allowlisted HomeHub radio lifecycle. Never changes QTS bluetoothd,
 * SelfCare database, persistent /var/lib/bluetooth pairing keys or other containers.
 */
import fs from 'node:fs';
import path from 'node:path';

const RADIO = 'qnaphomehub-radio';
const expectedProject = 'qnaphomehub';

function fail(message) { throw new Error(message); }
function label(container, key) { return container.Config?.Labels?.[key]; }

export function checkRadioIdentity(container, projectDir) {
  if (container.Name !== '/' + RADIO) fail('Unexpected Docker container name; no changes made');
  if (label(container, 'com.docker.compose.project') !== expectedProject ||
      label(container, 'com.docker.compose.service') !== 'radio') {
    fail('Radio Compose project/service labels differ; no changes made');
  }
  if (container.HostConfig?.NetworkMode !== 'host') fail('Radio network mode differs; no changes made');
  const mounts = container.Mounts || [];
  for (const dest of ['/radio', '/var/lib/bluetooth']) {
    const matches = mounts.filter(item => item.Destination === dest && item.Type === 'bind');
    if (matches.length !== 1) fail('Radio persistent mount missing: ' + dest);
    if (!path.resolve(matches[0].Source).startsWith(path.resolve(projectDir) + path.sep)) {
      fail('Radio bind mount outside expected HomeHub directory: ' + dest);
    }
  }
  const expected = path.resolve(projectDir);
  const working = label(container, 'com.docker.compose.project.working_dir');
  if (!working || path.resolve(working) !== expected) fail('Radio Compose working directory mismatch');
  return true;
}

export function statusFromInspect(container) {
  const tmpfs = container.HostConfig?.Tmpfs || {};
  return {
    available: true,
    running: container.State?.Running === true,
    status: container.State?.Status || 'unknown',
    restartPolicy: container.HostConfig?.RestartPolicy?.Name || 'no',
    loggingDriver: container.HostConfig?.LogConfig?.Type || 'unknown',
    tmpfsDbus: Object.hasOwn(tmpfs, '/run/dbus'),
    tmpfsTmp: Object.hasOwn(tmpfs, '/tmp'),
    lowIo: container.HostConfig?.LogConfig?.Type === 'none' &&
      Object.hasOwn(tmpfs, '/run/dbus') && Object.hasOwn(tmpfs, '/tmp'),
    note: 'Bluetooth and SelfCare sync are unavailable while radio is stopped.',
  };
}

export function createRadioControl({ command, projectDir, composeProject = expectedProject, overlay }) {
  if (!command || typeof command !== 'function') throw new Error('Docker command backend required');
  const baseFile = path.join(projectDir, 'compose.yaml');
  let busy = false;
  async function inspect() {
    // Inspect stays read-only. Returned JSON is never relayed to the browser.
    const data = JSON.parse(await command(['docker', 'inspect', RADIO]));
    if (!Array.isArray(data) || data.length !== 1) fail('Unexpected Docker inspect reply');
    checkRadioIdentity(data[0], projectDir);
    return data[0];
  }
  async function status() {
    const container = await inspect();
    return { ...statusFromInspect(container), busy };
  }
  async function execute(mode, { updateBusy = () => false } = {}) {
    if (!['stop', 'start', 'low-io'].includes(mode)) fail('Unsupported radio action');
    if (busy || updateBusy()) fail('HomeHub update or radio operation already in progress');
    busy = true;
    try {
      const container = await inspect();
      if (mode === 'stop') {
        // Set restart=no BEFORE stopping, so the radio stays stopped after NAS reboot.
        await command(['docker', 'update', '--restart=no', RADIO]);
        if (container.State?.Running) await command(['docker', 'stop', '-t', '15', RADIO]);
      } else if (mode === 'start') {
        // Start the existing configuration; does not recreate or undo low-I/O mounts.
        if (!container.State?.Running) await command(['docker', 'start', RADIO]);
        await command(['docker', 'update', '--restart=unless-stopped', RADIO]);
      } else {
        // Compose overlay is packaged in this updater image, not written to the NAS.
        // No dependent containers are created or started.
        if (!fs.existsSync(baseFile) || !fs.existsSync(overlay)) {
          fail('Compose file or bundled low-I/O overlay missing; no changes made');
        }
        await command(['docker', 'compose', '-p', composeProject,
          '--project-directory', projectDir, '-f', baseFile, '-f', overlay,
          'up', '-d', '--no-deps', '--force-recreate', 'radio']);
      }
      return { action: mode, ...await status() };
    } finally { busy = false; }
  }
  return { status, execute, get busy() { return busy; } };
}
