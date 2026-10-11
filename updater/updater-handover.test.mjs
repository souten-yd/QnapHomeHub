import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverArgs, handoverIdentity } from './updater-handover.mjs';

test('handover only recreates updater with no deps or builds', () => {
  assert.deepEqual(handoverArgs('/share/Container/QnapHomeHub'), [
    'compose', '-p', 'qnaphomehub', '--project-directory', '/share/Container/QnapHomeHub',
    '-f', '/share/Container/QnapHomeHub/compose.yaml',
    'up', '-d', '--no-deps', '--no-build', '--force-recreate', '--pull', 'never', 'updater',
  ]);
});
test('handover refuses another Compose project or service identity', () => {
  const good = { Name: '/qnaphomehub-updater', Config: { Labels: {
    'com.docker.compose.project': 'qnaphomehub',
    'com.docker.compose.service': 'updater',
  } } };
  assert.equal(handoverIdentity(good), true);
  assert.equal(handoverIdentity({ ...good, Name: '/qnaphomehub-radio' }), false);
  assert.equal(handoverIdentity({ ...good, Config: { Labels: {
    ...good.Config.Labels, 'com.docker.compose.project': 'other',
  } } }), false);
  assert.throws(() => handoverArgs('/etc/other'), /Unexpected/);
  assert.throws(() => handoverArgs('/share/Container/QnapHomeHub', 'other'), /Unexpected/);
});
