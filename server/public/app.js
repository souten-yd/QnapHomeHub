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
  const data = text ? JSON.parse(text) : null;
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

async function boot() {
  const health = await fetch('/api/health').then(response => response.json());
  $('#health').textContent = 'オンライン';
  $('#matterLink').href = `http://${location.hostname}:8283`;
  try {
    config = await api('/api/config');
    showApp();
    renderConfig();
    await renderRegistered();
  } catch (error) {
    if (!health.authRequired) console.error(error);
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value }),
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
    node.querySelector('.add').onclick = async event => {
      const article = event.target.closest('article');
      try {
        await api('/api/devices', {
          method: 'POST',
          body: JSON.stringify({
            id: device.id,
            name: article.querySelector('.name').value,
            mode: article.querySelector('.mode').value,
            matterType: 'outlet',
            exposeMatter: true,
          }),
        });
        await renderRegistered();
      } catch (error) {
        alert(error.message);
      }
    };
    root.append(node);
  }
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
    article.querySelector('h3').textContent = device.name;
    article.querySelector('.meta').textContent = `${device.mode} · ${device.mac || device.id} · Matter: ${device.matterType}`;
    article.querySelector('.matter').textContent = device.exposeMatter ? 'Matter ON' : 'Matter OFF';

    const editName = article.querySelector('.editName');
    const editMode = article.querySelector('.editMode');
    const editMatterType = article.querySelector('.editMatterType');
    editName.value = device.name;
    editMode.value = device.mode;
    editMatterType.value = device.matterType;

    article.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = async () => {
        const result = article.querySelector('.result');
        try {
          const data = await api(`/api/devices/${encodeURIComponent(device.id)}/${button.dataset.action}`, { method: 'POST' });
          result.textContent = JSON.stringify(data, null, 2);
          result.classList.remove('hidden');
        } catch (error) {
          result.textContent = error.message;
          result.classList.remove('hidden');
        }
      };
    });

    article.querySelector('.toggleMatter').onclick = async () => {
      await api(`/api/devices/${encodeURIComponent(device.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ exposeMatter: !device.exposeMatter }),
      });
      await renderRegistered();
    };

    article.querySelector('.saveDevice').onclick = async () => {
      try {
        await api(`/api/devices/${encodeURIComponent(device.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: editName.value,
            mode: editMode.value,
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

boot().catch(error => console.error(error));
