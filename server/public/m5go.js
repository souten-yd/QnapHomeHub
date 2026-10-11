const $ = selector => document.querySelector(selector);
let loaded = false;
let busy = false;
let formDirty = false;
$('#m5goForm').addEventListener('input', () => { formDirty = true; });

async function request(payload) {
  const response = await fetch('/api/m5go', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'M5GO request failed');
  return data;
}
function render(value, replaceInputs = false) {
  $('#m5goState').textContent = `${value.route === 'm5go' ? 'M5GO' : 'USB'} · ${value.apiConnected ? 'API接続中' : 'API未接続'}`;
  if ((!loaded && !formDirty) || replaceInputs) {
    $('#m5goHost').value = value.host;
    $('#m5goTarget').value = value.target;
    $('#m5goRoute').value = value.route;
    $('#m5goKey').value = '';
    $('#m5goKey').placeholder = value.keyConfigured ? '登録済み（空欄で維持）' : '32バイトのbase64鍵';
    formDirty = false;
  }
  loaded = true;
  const sync = value.lastSync;
  if (value.advertisement) $('#m5goRssi').textContent = `${value.advertisement.rssi} dBm · ${new Date(value.advertisement.at).toLocaleTimeString()}`;
  $('#m5goSync').textContent = sync ? `${sync.at} · ${sync.success ? `${sync.records}件返却` : '失敗'}` : '未実行（再起動で表示はリセット）';
  $('#m5goDiagnostics').textContent = JSON.stringify({ diagnostics: value.diagnostics || {}, pairingSupported: value.pairingSupported, error: value.error }, null, 2);
  if (value.error) $('#m5goMessage').textContent = value.error;
}
async function run(work) {
  if (busy) return;
  busy = true;
  const buttons = [...$('#m5goPanel').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try { await work(); }
  catch (error) { $('#m5goMessage').textContent = error.message; }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
$('#m5goForm').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const patch = { host: $('#m5goHost').value.trim(), target: $('#m5goTarget').value.trim(), route: $('#m5goRoute').value };
    const key = $('#m5goKey').value.trim();
    if (key) patch.noisePsk = key;
    render(await request({ action: 'config', patch }), true);
    $('#m5goMessage').textContent = '保存しました。実行中の操作が完了してから経路が切り替わります。SelfCareで自動同期を有効にしてください。';
  });
});
$('#m5goRollback').addEventListener('click', () => void run(async () => {
  render(await request({ action: 'config', patch: { route: 'usb' } }), true);
  $('#m5goMessage').textContent = 'USB経路へ切り戻しました。次の同期から適用されます。';
}));
$('#m5goRefresh').addEventListener('click', () => void run(async () => render(await request({ action: 'status' }))));
async function probe(connect) {
  await run(async () => {
    $('#m5goMessage').textContent = '保存済みの設定で検査中です。体組成計を通信可能にしてください。';
    const result = await request({ action: 'probe', connect });
    $('#m5goRssi').textContent = typeof result.rssi === 'number' ? `${result.rssi} dBm` : '未検出';
    $('#m5goMessage').textContent = `API ${result.api_connected ? '成功' : '失敗'} / 広告 ${result.advertisement_seen ? '検出' : '未検出'}${connect ? ` / GATT ${result.gatt_connected ? '成功' : '失敗'} / Omronサービス ${result.omron_service_found ? '検出' : '未検出'}` : ''}。履歴同期の成功判定はSelfCareの保存結果で確認してください。`;
  });
}
$('#m5goProbe').addEventListener('click', () => void probe(false));
$('#m5goGatt').addEventListener('click', () => void probe(true));
$('#m5goBond').addEventListener('click', () => void run(async () => {
  if (!$('#m5goBondConfirm').checked) throw new Error('対象機器とBLE bond作成のチェックを確認してください');
  await request({ action: 'bond', confirm: 'bond-hbf-228t' });
  $('#m5goBondConfirm').checked = false;
  $('#m5goMessage').textContent = 'M5GOのBLE bond作成が完了しました。Omronアプリ認証と履歴同期は別途確認してください。';
}));
// Wait until the existing login flow shows the management page. Poll only RAM status.
setInterval(() => {
  if (document.hidden || $('#app').classList.contains('hidden') || busy) return;
  void run(async () => render(await request({ action: 'status' })));
}, 10000);
