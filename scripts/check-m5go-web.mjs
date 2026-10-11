// CI credentials only; exercises the real authenticated HTTP -> radio socket route.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8787';
const post = (payload, cookie) => fetch(base + '/api/m5go', {method:'POST', headers:{'content-type':'application/json', ...(cookie ? {cookie} : {})},body:JSON.stringify(payload)});
assert.equal((await post({action:'status'})).status,401);
const login = await fetch(base + '/api/auth/login', {method:'POST', headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'ci-password'})});
assert.equal(login.status,200);
const cookie = login.headers.get('set-cookie').split(';')[0];
let response = await post({action:'status'},cookie);
assert.equal(response.status,200);
assert.equal((await response.json()).route,'usb');
response = await post({action:'config',patch:{noisePsk:'invalid-secret'}},cookie);
assert.equal(response.status,400);
const body = await response.text();
assert.equal(body.includes('invalid-secret'),false);
console.log('M5GO Web authentication and secret validation passed');
