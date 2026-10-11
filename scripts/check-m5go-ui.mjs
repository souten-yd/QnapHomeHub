// Optional local browser regression. Install playwright separately and set PLAYWRIGHT_MODULE if needed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('server/public');
const server=http.createServer(async(req,res)=>{
  try {const file=path.join(root, req.url === '/' ? 'manage.html' : req.url);res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(18789,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1280,height:960}});
let state={host:'',target:'',route:'usb',keyConfigured:false,apiConnected:false};
let savedKey='';let calls=[];
await page.route('**/app.js',r=>r.fulfill({contentType:'application/javascript',body:"document.querySelector('#app').classList.remove('hidden');"}));
await page.route('**/update.js',r=>r.fulfill({contentType:'application/javascript',body:''}));
await page.route('**/api/m5go',async r=>{
 const body=r.request().postDataJSON();calls.push(body);
 if(body.action==='config') {const {noisePsk,...patch}=body.patch;state={...state,...patch};if(noisePsk){savedKey=noisePsk;state.keyConfigured=true;}}
 let result=state;
 if(body.action==='probe') result={api_connected:true,advertisement_seen:true,rssi:-49,gatt_connected:body.connect,omron_service_found:body.connect};
 if(body.action==='bond') result={bonded:true,application_key_changed:false};
 await r.fulfill({json:result});
});
await page.goto('http://127.0.0.1:18789/');
await page.locator('#m5goRefresh').click();
await page.locator('#m5goHost').fill('192.168.1.28');
await page.locator('#m5goKey').fill(Buffer.alloc(32,1).toString('base64'));
await page.locator('#m5goTarget').fill('AA:BB:CC:11:22:33');
await page.locator('#m5goRoute').selectOption('m5go');
await page.locator('#m5goForm button[type=submit]').click();
await page.waitForFunction(()=>document.querySelector('#m5goMessage').textContent.includes('保存しました'));
assert.equal(await page.locator('#m5goKey').inputValue(),'');
assert.equal(state.route,'m5go',JSON.stringify(calls));assert.equal(savedKey.length,44);
await page.locator('#m5goGatt').click();
await page.waitForFunction(()=>document.querySelector('#m5goMessage').textContent.includes('GATT 成功'));
assert.match(await page.locator('#m5goRssi').textContent(),/-49/);
await page.locator('#m5goRollback').click();
await page.waitForFunction(()=>document.querySelector('#m5goMessage').textContent.includes('切り戻しました'));
assert.equal(state.route,'usb');
assert.equal(calls.at(-1).patch.noisePsk,undefined);
await page.locator('#m5goPanel').screenshot({path:'/tmp/qhh-m5go-ui-desktop.png'});
await page.setViewportSize({width:360,height:900});
await page.locator('#m5goPanel').screenshot({path:'/tmp/qhh-m5go-ui-mobile.png'});
const overflow=await page.locator('#m5goPanel').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));
console.log('UI mock: settings, key clearing, GATT/RSSI, rollback, desktop/mobile layout PASS');
}finally{await browser.close();server.close();}
