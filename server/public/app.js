const $ = selector => document.querySelector(selector);

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('Authentication required');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { error: text }; }
  }
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
};

const showLogin = () => {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
};
const showApp = () => {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
};

let config;
let debugBusy = false;

function setTheme(theme) {
  const selected = theme === 'cyber' ? 'cyber' : 'black';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem('qnaphomehub-theme', selected);
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.classList.toggle('active', button.dataset.themeChoice === selected);
  });
}

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
}
setTheme(localStorage.getItem('qnaphomehub-theme') || 'black');

async function boot() {
  const health = await fetch('/api/health').then(response => response.json());
  $('#health').textContent = `オンライン · ${health.version}`;
  $('#matterLink').href = `http://${location.hostname}:8283`;
  try {
    config = await api('/api/config');
    showApp();
    renderConfig();
    await renderRegistered();
    await refreshDebug(false);
  } catch (error) {
    if (!health.authRequired) console.error(error);
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#username').value, password: $('#password').value }),
    });
    $('#loginError').textContent = '';
    await boot();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#scan').addEventListener('click', async () => {
  const button = $('#scan');
  button.disabled = true;
  button.textContent = 'スキャン中…';
  try {
    const data = await api('/api/scan', { method: 'POST' });
    renderDiscovered(data.devices);
    await refreshDebug(false);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Bluetoothをスキャン';
  }
});

function renderDiscovered(devices) {
  const root = $('#discovered');
  root.innerHTML = '';
  root.classList.toggle('empty', !devices.length);
  if (!devices.length) {
    root.textContent = 'SwitchBotを検出できませんでした。';
    return;
  }
  for (const device of devices) {
    const node = $('#discoveredTpl').content.cloneNode(true);
    node.querySelector('h3').textContent = device.name || device.deviceType;
    node.querySelector('.meta').textContent = `${device.deviceType} · ${device.mac || device.id} · RSSI ${device.rssi ?? '-'}`;
    node.querySelector('.name').value = device.name || 'SwitchBot';
    const mode = node.querySelector('.mode');
    const controlProfile = node.querySelector('.controlProfile');
    controlProfile.onchange = () => {
      const pcPower = controlProfile.value === 'pc-power';
      if (pcPower) mode.value = 'press';
      mode.disabled = pcPower;
    };
    node.querySelector('.add').onclick = async event => {
      const article = event.target.closest('article');
      try {
        await api('/api/devices', {
          method: 'POST',
          body: JSON.stringify({
            id: device.id,
            name: article.querySelector('.name').value,
            mode: article.querySelector('.mode').value,
            controlProfile: article.querySelector('.controlProfile').value,
            forceHoldSeconds: 10,
            matterType: 'outlet',
            exposeMatter: true,
          }),
        });
        await renderRegistered();
        await refreshDebug(false);
      } catch (error) {
        alert(error.message);
      }
    };
    root.append(node);
  }
}

function setCommandFeedback(article, state, text) {
  const feedback = article.querySelector('.commandFeedback');
  feedback.className = `commandFeedback ${state}`;
  feedback.textContent = text;
}

function configureDeviceControls(article, device) {
  const profile = device.controlProfile || 'standard';
  const pcPower = profile === 'pc-power';
  const pressMode = device.mode === 'press';
  const press = article.querySelector('[data-action="press"]');
  const power = article.querySelector('[data-action="power"]');
  const forceOff = article.querySelector('[data-action="forceOff"]');
  const on = article.querySelector('[data-action="on"]');
  const off = article.querySelector('[data-action="off"]');

  press.classList.toggle('hidden', pcPower || !pressMode);
  power.classList.toggle('hidden', !pcPower);
  forceOff.classList.toggle('hidden', !pcPower);
  on.classList.toggle('hidden', pcPower || pressMode);
  off.classList.toggle('hidden', pcPower || pressMode);
  forceOff.textContent = `強制終了（${device.forceHoldSeconds ?? 10}秒）`;
}

function syncProfileSettings(article) {
  const profile = article.querySelector('.editControlProfile');
  const mode = article.querySelector('.editMode');
  const holdField = article.querySelector('.forceHoldField');
  const note = article.querySelector('.pcPowerNote');
  const pcPower = profile.value === 'pc-power';
  if (pcPower) mode.value = 'press';
  mode.disabled = pcPower;
  holdField.classList.toggle('hidden', !pcPower);
  note.classList.toggle('hidden', !pcPower);
}

async function renderRegistered() {
  const { devices } = await api('/api/devices');
  const root = $('#registered');
  root.innerHTML = '';
  root.classList.toggle('empty', !devices.length);
  if (!devices.length) {
    root.textContent = '登録デバイスなし';
    return;
  }

  for (const device of devices) {
    const node = $('#registeredTpl').content.cloneNode(true);
    const article = node.querySelector('article');
    const profile = device.controlProfile || 'standard';
    article.querySelector('h3').textContent = device.name;
    article.querySelector('.meta').textContent = `${device.mode} · ${profile === 'pc-power' ? `PC電源 · 強制${device.forceHoldSeconds ?? 10}秒` : '標準'} · ${device.mac || device.id} · Matter: ${device.matterType}`;
    article.querySelector('.matter').textContent = device.exposeMatter ? 'Matter ON' : 'Matter OFF';

    configureDeviceControls(article, device);

    const editName = article.querySelector('.editName');
    const editMode = article.querySelector('.editMode');
    const editControlProfile = article.querySelector('.editControlProfile');
    const editForceHoldSeconds = article.querySelector('.editForceHoldSeconds');
    const editMatterType = article.querySelector('.editMatterType');
    editName.value = device.name;
    editMode.value = device.mode;
    editControlProfile.value = profile;
    editForceHoldSeconds.value = device.forceHoldSeconds ?? 10;
    editMatterType.value = device.matterType;
    editControlProfile.onchange = () => syncProfileSettings(article);
    syncProfileSettings(article);

    article.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = async () => {
        const result = article.querySelector('.result');
        const action = button.dataset.action;
        const oldText = button.textContent;
        if (action === 'forceOff') {
          const holdSeconds = Number(editForceHoldSeconds.value || device.forceHoldSeconds || 10);
          const confirmed = confirm(`${device.name} のPC電源ボタンを約${holdSeconds}秒間長押しします。\n\nOSを介さない強制終了になります。実行しますか？`);
          if (!confirmed) return;
        }
        button.disabled = true;
        button.textContent = '送信中…';
        setCommandFeedback(article, 'pending', `${oldText} をHomeHubへ送信中…`);
        result.classList.add('hidden');
        try {
          const data = await api(`/api/devices/${encodeURIComponent(device.id)}/${action}`, { method: 'POST' });
          const failed = data?.success === false;
          if (failed) {
            setCommandFeedback(article, 'failure', `失敗: ${data.error || 'SwitchBotがsuccess=falseを返しました'}`);
          } else {
            const connection = data?.connectionType ? ` · ${data.connectionType.toUpperCase()}` : '';
            const hold = data?.holdSeconds ? ` · ${data.holdSeconds}秒` : '';
            setCommandFeedback(article, 'success', `${oldText} 完了${connection}${hold}`);
          }
          result.textContent = JSON.stringify(data, null, 2);
          result.classList.remove('hidden');
        } catch (error) {
          setCommandFeedback(article, 'failure', `APIエラー: ${error.message}`);
          result.textContent = error.message;
          result.classList.remove('hidden');
        } finally {
          button.disabled = false;
          button.textContent = oldText;
          await refreshDebug(false).catch(() => undefined);
        }
      };
    });

    article.querySelector('.toggleMatter').onclick = async () => {
      await api(`/api/devices/${encodeURIComponent(device.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ exposeMatter: !device.exposeMatter }),
      });
      await renderRegistered();
      await refreshDebug(false);
    };

    article.querySelector('.saveDevice').onclick = async () => {
      try {
        await api(`/api/devices/${encodeURIComponent(device.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: editName.value,
            mode: editMode.value,
            controlProfile: editControlProfile.value,
            forceHoldSeconds: Number(editForceHoldSeconds.value),
            matterType: editMatterType.value,
          }),
        });
        await renderRegistered();
      } catch (error) {
        alert(error.message);
      }
    };

    article.querySelector('.remove').onclick = async () => {
      if (!confirm(`${device.name} を削除しますか？`)) return;
      await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      await renderRegistered();
      await refreshDebug(false);
    };
    root.append(node);
  }
}

function renderConfig() {
  $('#hciDeviceId').value = config.hciDeviceId;
  $('#scanTimeoutMs').value = config.scanTimeoutMs;
  $('#apiFallback').checked = config.apiFallback;
  $('#scanOnStartup').checked = config.scanOnStartup;
}

$('#saveConfig').onclick = async () => {
  config = await api('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({
      hciDeviceId: Number($('#hciDeviceId').value),
      scanTimeoutMs: Number($('#scanTimeoutMs').value),
      apiFallback: $('#apiFallback').checked,
      scanOnStartup: $('#scanOnStartup').checked,
    }),
  });
  renderConfig();
  await refreshDebug(false);
  if (config.restartRequired) alert('HCI/API経路の変更は再起動後に反映されます。');
};

$('#diagnostics').onclick = async () => {
  const data = await api('/api/diagnostics');
  $('#diag').textContent = JSON.stringify(data, null, 2);
  $('#diag').classList.remove('hidden');
};

$('#restart').onclick = async () => {
  if (!confirm('QnapHomeHubコンテナを再起動しますか？')) return;
  await api('/api/system/restart', { method: 'POST' });
  location.reload();
};

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString('ja-JP', { hour12: false }); }
  catch { return iso; }
}

function renderDebugEvents(events) {
  const root = $('#debugEvents');
  root.replaceChildren();
  const list = [...(events || [])].reverse();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'commandFeedback idle';
    empty.textContent = 'デバッグイベントなし';
    root.append(empty);
    return;
  }
  for (const event of list) {
    const row = document.createElement('div');
    row.className = `debugEvent ${event.level || 'info'}`;
    for (const [className, text] of [
      ['time', formatTime(event.at)],
      ['level', event.level || 'info'],
      ['source', event.source || '-'],
      ['message', event.message || ''],
    ]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      row.append(span);
    }
    if (event.details && Object.keys(event.details).length) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'details';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(event.details, null, 2);
      details.append(summary, pre);
      row.append(details);
    }
    root.append(row);
  }
}

async function refreshDebug(showError = true) {
  if (debugBusy || $('#app').classList.contains('hidden')) return;
  debugBusy = true;
  try {
    const data = await api('/api/debug/status?limit=160');
    const matter = data.matterbridge || {};
    const http = matter.http || {};
    $('#debugHomehub').textContent = `ONLINE · ${data.homehub.version || '-'} · ${data.homehub.registeredCount} registered`;
    $('#debugBle').textContent = `hci${data.homehub.hciDeviceId} · ${data.homehub.discoveredCount} discovered`;
    $('#debugMatter').textContent = `${http.reachable ? 'HTTP OK' : 'HTTP NG'} · ${matter.state || 'not-seen'} · ${matter.deviceCount ?? 0} devices`;
    const matterOk = http.reachable && matter.state === 'ready';
    $('#debugBadge').textContent = matterOk ? 'ALL GREEN' : (http.reachable ? 'CHECK PLUGIN' : 'MATTER OFFLINE');
    $('#debugBadge').className = `pill ${matterOk ? 'debugGood' : 'debugWarn'}`;
    $('#debugSummary').textContent = JSON.stringify({
      homehub: data.homehub,
      matterbridge: data.matterbridge,
      system: data.system,
    }, null, 2);
    renderDebugEvents(data.events);
  } catch (error) {
    $('#debugBadge').textContent = 'DEBUG ERROR';
    if (showError) $('#debugSummary').textContent = `デバッグ取得失敗: ${error.message}`;
  } finally {
    debugBusy = false;
  }
}

$('#refreshDebug').onclick = () => refreshDebug(true);
$('#clearDebug').onclick = async () => {
  await api('/api/debug/clear', { method: 'POST' });
  await refreshDebug(true);
};
$('#debugPanel').addEventListener('toggle', () => {
  if ($('#debugPanel').open) void refreshDebug(false);
});
setInterval(() => {
  if ($('#autoDebug')?.checked) void refreshDebug(false);
}, 2000);

boot().catch(error => console.error(error));
