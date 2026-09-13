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
  $('#controlApp').classList.add('hidden');
};

const showApp = () => {
  $('#login').classList.add('hidden');
  $('#controlApp').classList.remove('hidden');
};

let activeActions = 0;

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

function profileLabel(device) {
  if ((device.controlProfile || 'standard') === 'pc-power') return 'PC POWER';
  if (device.mode === 'press') return 'BUTTON';
  return 'SWITCH';
}

function actionLabel(action) {
  return ({
    power: '起動',
    forceOff: '強制終了',
    press: '押す',
    on: 'ON',
    off: 'OFF',
  })[action] || action;
}

function setFeedback(card, state, text) {
  const feedback = card.querySelector('.controlFeedback');
  feedback.className = `controlFeedback ${state}`;
  feedback.textContent = text;
}

async function executeAction(card, device, action, button) {
  if (action === 'forceOff') {
    const confirmed = confirm(`${device.name} を強制終了します。\n\nPCの電源ボタンを長押しします。実行しますか？`);
    if (!confirmed) return;
  }

  const label = actionLabel(action);
  activeActions += 1;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '実行中…';
  setFeedback(card, 'pending', `${label} を実行しています…`);

  try {
    const result = await api(`/api/devices/${encodeURIComponent(device.id)}/${action}`, { method: 'POST' });
    if (result?.success === false) {
      setFeedback(card, 'failure', `失敗: ${result.error || 'デバイスがsuccess=falseを返しました'}`);
      return;
    }
    const connection = result?.connectionType ? ` · ${String(result.connectionType).toUpperCase()}` : '';
    setFeedback(card, 'success', `${label} 完了${connection}`);
  } catch (error) {
    setFeedback(card, 'failure', `失敗: ${error.message}`);
  } finally {
    activeActions = Math.max(0, activeActions - 1);
    button.disabled = false;
    button.textContent = original;
  }
}

function addActionButton(actions, card, device, action, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `controlButton ${className}`.trim();
  button.textContent = actionLabel(action);
  button.onclick = () => executeAction(card, device, action, button);
  actions.append(button);
}

function renderDevices(devices) {
  const root = $('#controlDevices');
  root.replaceChildren();
  root.classList.toggle('empty', !devices.length);

  if (!devices.length) {
    root.textContent = '操作できる登録済みデバイスがありません。管理画面からデバイスを登録してください。';
    return;
  }

  for (const device of devices) {
    const card = document.createElement('article');
    card.className = 'controlDevice';

    const head = document.createElement('div');
    head.className = 'controlDeviceHead';
    const title = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'sectionLabel';
    label.textContent = profileLabel(device);
    const name = document.createElement('h2');
    name.textContent = device.name;
    title.append(label, name);
    head.append(title);

    const actions = document.createElement('div');
    actions.className = 'controlPrimaryActions';
    const pcPower = (device.controlProfile || 'standard') === 'pc-power';
    if (pcPower) {
      addActionButton(actions, card, device, 'power', 'primaryAction');
      addActionButton(actions, card, device, 'forceOff', 'danger primaryAction');
    } else if (device.mode === 'press') {
      addActionButton(actions, card, device, 'press', 'primaryAction');
    } else {
      addActionButton(actions, card, device, 'on', 'primaryAction');
      addActionButton(actions, card, device, 'off', 'secondary primaryAction');
    }

    const feedback = document.createElement('div');
    feedback.className = 'controlFeedback idle';
    feedback.textContent = '操作待ち';

    card.append(head, actions, feedback);
    root.append(card);
  }
}

async function refreshDevices() {
  if (activeActions > 0) return;
  const refresh = $('#refreshControls');
  refresh.disabled = true;
  try {
    const { devices } = await api('/api/devices');
    renderDevices(devices || []);
    $('#deviceCount').textContent = `${devices?.length || 0} DEVICES`;
  } catch (error) {
    if (error.message !== 'Authentication required') {
      $('#controlDevices').textContent = `デバイス取得失敗: ${error.message}`;
    }
  } finally {
    refresh.disabled = false;
  }
}

async function boot() {
  const health = await fetch('/api/health').then(response => response.json());
  $('#health').textContent = `オンライン · ${health.version}`;
  try {
    await api('/api/devices');
    showApp();
    await refreshDevices();
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
    showApp();
    await refreshDevices();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#refreshControls').onclick = refreshDevices;
setInterval(() => {
  if (!$('#controlApp').classList.contains('hidden') && activeActions === 0) void refreshDevices();
}, 30000);

boot().catch(error => {
  $('#health').textContent = 'オフライン';
  console.error(error);
});
