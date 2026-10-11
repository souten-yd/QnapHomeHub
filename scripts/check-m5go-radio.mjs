// CI only: deliberately unreachable proxy and dummy key. No physical radio operation.
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const key = Buffer.alloc(32, 1).toString('base64');
const request = (endpoint, payload) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath:'/radio/ble.sock', path:endpoint, method:payload ? 'POST' : 'GET' }, res => {
    let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => {
      try { assert.equal(res.statusCode, 200); resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
  req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
});
let health;
for (let n = 0; n < 30; n++) {
  try { health = await request('/health'); break; }
  catch { await new Promise(resolve => setTimeout(resolve, 500)); }
}
assert.ok(health);
const phase = process.argv[2];
if (phase === 'configure') {
  assert.equal(health.m5go.route, 'usb');
  const result = await request('/proxy', {action:'config', patch:{host:'127.0.0.1', noisePsk:key, target:'AA:BB:CC:11:22:33', route:'m5go'}});
  assert.equal(result.route, 'm5go');
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await fs.stat('/radio/m5go.json')).mode & 0o777, 0o600);
} else if (phase === 'restored') {
  assert.equal(health.m5go.route, 'm5go');
  assert.equal(health.m5go.keyConfigured, true);
  assert.equal(health.m5go.apiConnected, false);
  assert.equal(JSON.stringify(health).includes(key), false);
  const watch = await request('/watch', {adapter:'hci0', addresses:['AA:BB:CC:11:22:33']});
  assert.equal(watch.supported, true);
  assert.equal(watch.ready, false);
} else if (phase === 'rollback') {
  const result = await request('/proxy', {action:'config', patch:{route:'usb', host:'', noisePsk:''}});
  assert.equal(result.route, 'usb');
  await request('/watch', {adapter:'hci0', addresses:[]});
} else throw new Error('Unknown phase');
console.log(`M5GO Docker ${phase}: passed (mock/offline, no real-device acceptance)`);
