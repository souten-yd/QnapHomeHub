import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRadioControl, checkRadioIdentity, statusFromInspect } from './radio-control.mjs';

const ROOT = '/share/Container/QnapHomeHub';
const container = ({ running = true, lowIo = false } = {}) => ({
  Name: '/qnaphomehub-radio',
  State: { Running: running, Status: running ? 'running' : 'exited' },
  Config: { Labels: {
    'com.docker.compose.project': 'qnaphomehub',
    'com.docker.compose.service': 'radio',
    'com.docker.compose.project.working_dir': ROOT,
  } },
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

test('inspect status reports concrete disk-saving settings without any write', async () => {
  const calls = [];
  const api = createRadioControl({ projectDir: ROOT, overlay: '/app/compose.radio-low-io.yaml',
    command: async args => { calls.push(args); return JSON.stringify([container({ lowIo: true })]); } });
  const status = await api.status();
  assert.equal(status.lowIo, true);
  assert.equal(status.loggingDriver, 'none');
  assert.equal(status.tmpfsDbus, true);
  assert.deepEqual(calls.map(x => x.slice(0, 2)), [['docker', 'inspect']]);
});
test('stop disables restart before stopping; touches only radio', async () => {
  const calls = [];
  const api = createRadioControl({ projectDir: ROOT,
    command: async args => { calls.push(args); return JSON.stringify([container()]); } });
  await api.execute('stop');
  assert.deepEqual(calls.filter(c => c[1] !== 'inspect'), [
    ['docker', 'update', '--restart=no', 'qnaphomehub-radio'],
    ['docker', 'stop', '-t', '15', 'qnaphomehub-radio'],
  ]);
});
test('ordinary start never recreates Docker, even if radio is stopped', async () => {
  const calls = [];
  const api = createRadioControl({ projectDir: ROOT,
    command: async args => { calls.push(args); return JSON.stringify([container({ running: false })]); } });
  await api.execute('start');
  assert.deepEqual(calls.filter(c => c[1] !== 'inspect'), [
    ['docker', 'start', 'qnaphomehub-radio'],
    ['docker', 'update', '--restart=unless-stopped', 'qnaphomehub-radio'],
  ]);
});
test('low-IO startup recreates only radio with packaged RAM overlay', async () => {
  const calls = [];
  const original = fs.existsSync;
  fs.existsSync = () => true;
  try {
    const api = createRadioControl({ projectDir: ROOT, overlay: '/app/compose.radio-low-io.yaml',
      command: async args => { calls.push(args); return JSON.stringify([container({ lowIo: true })]); } });
    const status = await api.execute('low-io');
    assert.equal(status.lowIo, true);
    assert.deepEqual(calls.filter(c => c[1] !== 'inspect'), [[
      'docker', 'compose', '-p', 'qnaphomehub', '--project-directory', ROOT, '-f',
      ROOT + '/compose.yaml', '-f', '/app/compose.radio-low-io.yaml',
      'up', '-d', '--no-deps', '--force-recreate', 'radio',
    ]]);
  } finally { fs.existsSync = original; }
});
test('refuses unowned or unexpected radio containers before mutations', async () => {
  const x = container();
  x.Config.Labels['com.docker.compose.project'] = 'not-homehub';
  assert.throws(() => checkRadioIdentity(x, ROOT), /labels differ/);
  x.Config.Labels['com.docker.compose.project'] = 'qnaphomehub';
  x.Mounts[1].Source = '/outside/bluetooth';
  assert.throws(() => checkRadioIdentity(x, ROOT), /outside expected/);
  const calls = [];
  const api = createRadioControl({ projectDir: ROOT, command: async args => {
    calls.push(args);
    return JSON.stringify([x]);
  } });
  await assert.rejects(api.execute('stop'), /outside expected/);
  assert.equal(calls.some(x => x[1] !== 'inspect'), false);
  await assert.rejects(api.execute('restart everything'), /Unsupported/);
});
test('blocked update prevents radio action', async () => {
  const calls = [];
  const api = createRadioControl({ projectDir: ROOT, command: async args => {
    calls.push(args); return JSON.stringify([container()]);
  } });
  await assert.rejects(api.execute('stop', { updateBusy: () => true }), /already in progress/);
  assert.equal(calls.length, 0);
});
