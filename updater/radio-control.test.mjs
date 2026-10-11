import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRadioControl, checkRadioIdentity } from './radio-control.mjs';

const ROOT = '/share/Container/QnapHomeHub';
const RADIO = 'qnaphomehub-radio';
const container = ({ running = true, lowIo = false, hostBlueZ = false } = {}) => ({
  Name: '/' + RADIO,
  State: { Running: running, Status: running ? 'running' : 'exited' },
  Config: { Labels: {
    'com.docker.compose.project': 'qnaphomehub',
    'com.docker.compose.service': 'radio',
    'com.docker.compose.project.working_dir': ROOT,
  }, Env: hostBlueZ ? ['HOMEHUB_BLUEZ_MODE=host'] : ['HOMEHUB_BLUEZ_MODE=private'] },
  HostConfig: { NetworkMode: 'host',
    RestartPolicy: { Name: 'unless-stopped' },
    LogConfig: { Type: lowIo ? 'none' : 'json-file' },
    Tmpfs: lowIo ? { '/run/dbus': 'size=4m', '/tmp': 'size=16m' } : {},
  },
  Mounts: [
    { Destination: '/radio', Source: ROOT + '/data/radio', Type: 'bind' },
    { Destination: '/var/lib/bluetooth', Source: ROOT + '/data/bluetooth', Type: 'bind' },
  ],
});
function mockRadio(initial = {}) {
  let current = { running: true, lowIo: false, ...initial };
  const calls = [];
  const command = async args => {
    calls.push(args);
    if (args[1] === 'inspect') return JSON.stringify([container(current)]);
    if (args[1] === 'update') return '';
    if (args[1] === 'stop') { current.running = false; return ''; }
    if (args[1] === 'start') { current.running = true; return ''; }
    if (args[1] === 'compose') {
      if (args.includes('config')) return '';
      if (args.includes('--force-recreate')) {
        if (current.running) throw new Error('Attempted duplicate radio');
        current.running = true;
        current.lowIo = true;
      }
      return '';
    }
    throw new Error('Unexpected Docker action ' + args.join(' '));
  };
  return { calls, command, state: () => current };
}

test('status is read-only and reports actual low-IO log/tmpfs settings', async () => {
  const stub = mockRadio({ lowIo: true });
  const api = createRadioControl({ projectDir: ROOT, overlay: '/app/compose.radio-low-io.yaml',
    command: stub.command });
  const status = await api.status();
  assert.equal(status.lowIo, true);
  assert.equal(status.loggingDriver, 'none');
  assert.equal(status.tmpfsDbus, true);
  assert.deepEqual(stub.calls.map(c => c.slice(0, 2)), [['docker', 'inspect']]);
});

test('radio stop disables restart before stop and verifies stopped result', async () => {
  const stub = mockRadio();
  const api = createRadioControl({ projectDir: ROOT, command: stub.command });
  const result = await api.execute('stop');
  assert.equal(result.running, false);
  assert.deepEqual(stub.calls.filter(c => c[1] !== 'inspect'), [
    ['docker', 'update', '--restart=no', RADIO],
    ['docker', 'stop', '-t', '15', RADIO],
  ]);
});

test('ordinary start never creates a duplicate or overwrites low-IO config', async () => {
  const stub = mockRadio({ running: false, lowIo: true });
  const api = createRadioControl({ projectDir: ROOT, command: stub.command });
  const result = await api.execute('start');
  assert.equal(result.running, true);
  assert.equal(result.lowIo, true);
  assert.deepEqual(stub.calls.filter(c => c[1] !== 'inspect'), [
    ['docker', 'start', RADIO],
    ['docker', 'update', '--restart=unless-stopped', RADIO],
  ]);
});

test('low-IO button verifies Compose then STOPS existing radio BEFORE creating one replacement', async () => {
  const stub = mockRadio();
  const original = fs.existsSync;
  fs.existsSync = () => true;
  try {
    const api = createRadioControl({ projectDir: ROOT, overlay: '/app/compose.radio-low-io.yaml',
      command: stub.command });
    const result = await api.execute('low-io');
    assert.equal(result.running, true);
    assert.equal(result.lowIo, true);
    assert.deepEqual(stub.calls.filter(c => c[1] !== 'inspect'), [
      ['docker', 'compose', '-p', 'qnaphomehub', '--project-directory', ROOT, '-f',
        ROOT + '/compose.yaml', '-f', '/app/compose.radio-low-io.yaml', 'config', '--quiet'],
      ['docker', 'update', '--restart=no', RADIO],
      ['docker', 'stop', '-t', '15', RADIO],
      ['docker', 'compose', '-p', 'qnaphomehub', '--project-directory', ROOT, '-f',
        ROOT + '/compose.yaml', '-f', '/app/compose.radio-low-io.yaml',
        'up', '-d', '--no-deps', '--force-recreate', 'radio'],
    ]);
  } finally { fs.existsSync = original; }
});

test('low-IO stop failure never reaches Compose recreation', async () => {
  const stub = mockRadio();
  const original = fs.existsSync;
  fs.existsSync = () => true;
  try {
    const command = async args => {
      if (args[1] === 'stop') throw new Error('stop failure');
      return stub.command(args);
    };
    const api = createRadioControl({ projectDir: ROOT, overlay: '/app/compose.radio-low-io.yaml', command });
    await assert.rejects(api.execute('low-io'), /stop failure/);
    assert.equal(stub.calls.some(c => c.includes('--force-recreate')), false);
  } finally { fs.existsSync = original; }
});

test('host BlueZ and foreign radio identities cannot be replaced', async () => {
  const x = container();
  x.Config.Labels['com.docker.compose.project'] = 'wrong';
  assert.throws(() => checkRadioIdentity(x, ROOT), /labels differ/);
  x.Config.Labels['com.docker.compose.project'] = 'qnaphomehub';
  x.Mounts[1].Source = '/outside/bluetooth';
  assert.throws(() => checkRadioIdentity(x, ROOT), /outside expected/);
  const stub = mockRadio({ hostBlueZ: true });
  const api = createRadioControl({ projectDir: ROOT, command: stub.command });
  await assert.rejects(api.execute('low-io'), /Host BlueZ/);
  assert.equal(stub.calls.some(c => c[1] !== 'inspect'), false);
});

test('radio actions are blocked while release update is in progress', async () => {
  const stub = mockRadio();
  const api = createRadioControl({ projectDir: ROOT, command: stub.command });
  await assert.rejects(api.execute('stop', { updateBusy: () => true }), /already in progress/);
  assert.equal(stub.calls.length, 0);
});
