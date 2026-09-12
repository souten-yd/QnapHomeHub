const $u = selector => document.querySelector(selector);

let latestUpdateStatus = null;
let updatePolling = false;

async function updateApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { error: text }; }
  }
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function phaseLabel(phase) {
  return ({
    idle: '待機中', checking: 'Release確認中', preparing: '更新準備中', pulling: 'イメージ取得中',
    recreating: 'コンテナ更新中', verifying: 'ヘルスチェック中', rollback: 'ロールバック中',
    success: '更新完了', error: 'エラー',
  })[phase] || phase || '-';
}

function renderUpdate(status) {
  latestUpdateStatus = status;
  $u('#updateCurrent').textContent = status.currentVersion ? `v${status.currentVersion}` : '-';
  $u('#updateLatest').textContent = status.latestVersion ? `v${status.latestVersion}` : 'Release未確認';
  $u('#updatePhase').textContent = phaseLabel(status.phase);
  $u('#autoUpdateEnabled').checked = Boolean(status.autoUpdate);
  $u('#applyUpdate').disabled = Boolean(status.busy) || !status.updateAvailable || !status.latestTag;
  $u('#checkUpdate').disabled = Boolean(status.busy);
  const badge = $u('#updateBadge');
  if (status.phase === 'error') {
    badge.textContent = 'UPDATE ERROR';
    badge.className = 'pill debugWarn';
  } else if (status.updateAvailable) {
    badge.textContent = `v${status.latestVersion} AVAILABLE`;
    badge.className = 'pill debugWarn';
  } else if (status.latestVersion) {
    badge.textContent = 'UP TO DATE';
    badge.className = 'pill debugGood';
  } else {
    badge.textContent = 'RELEASE CHECK';
    badge.className = 'pill';
  }
  const message = $u('#updateMessage');
  if (status.lastError) message.textContent = `エラー: ${status.lastError}`;
  else if (status.busy) message.textContent = `${phaseLabel(status.phase)}。更新中はHomeHubが一時的に切断されます。`;
  else if (status.updateAvailable) message.textContent = `GitHub Release ${status.latestTag} を適用できます。`;
  else if (status.latestVersion) message.textContent = '最新のstable Releaseです。';
  else message.textContent = 'GitHub Releasesのstable版を確認します。';

  const link = $u('#releaseLink');
  if (status.releaseUrl) {
    link.href = status.releaseUrl;
    link.classList.remove('hidden');
  } else link.classList.add('hidden');
}

async function refreshUpdateStatus(showError = false) {
  try {
    const status = await updateApi('/api/update/status');
    renderUpdate(status);
    return status;
  } catch (error) {
    if (showError && $u('#updateMessage')) $u('#updateMessage').textContent = `Updater接続エラー: ${error.message}`;
    return null;
  }
}

async function waitForUpdateCompletion() {
  if (updatePolling) return;
  updatePolling = true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await refreshUpdateStatus(false);
    if (!status) continue;
    if (!status.busy && status.phase === 'success') {
      $u('#updateMessage').textContent = '更新完了。新しいHomeHubを再読み込みします…';
      setTimeout(() => location.reload(), 1200);
      break;
    }
    if (!status.busy && status.phase === 'error') break;
  }
  updatePolling = false;
}

$u('#checkUpdate')?.addEventListener('click', async () => {
  try {
    $u('#updateMessage').textContent = 'GitHub Releasesを確認しています…';
    renderUpdate(await updateApi('/api/update/check', { method: 'POST', body: '{}' }));
  } catch (error) { $u('#updateMessage').textContent = `更新確認失敗: ${error.message}`; }
});

$u('#autoUpdateEnabled')?.addEventListener('change', async event => {
  const checked = event.target.checked;
  try {
    renderUpdate(await updateApi('/api/update/config', {
      method: 'PATCH', body: JSON.stringify({ autoUpdate: checked }),
    }));
  } catch (error) {
    event.target.checked = !checked;
    $u('#updateMessage').textContent = `自動更新設定失敗: ${error.message}`;
  }
});

$u('#applyUpdate')?.addEventListener('click', async () => {
  const status = latestUpdateStatus;
  if (!status?.latestTag) return;
  if (!confirm(`${status.latestTag}へ更新しますか？\n失敗した場合は旧Dockerイメージへ自動ロールバックします。`)) return;
  try {
    $u('#applyUpdate').disabled = true;
    $u('#updateMessage').textContent = `${status.latestTag}の更新を開始します…`;
    await updateApi('/api/update/apply', { method: 'POST', body: JSON.stringify({ tag: status.latestTag }) });
    void waitForUpdateCompletion();
  } catch (error) {
    $u('#updateMessage').textContent = `更新開始失敗: ${error.message}`;
    $u('#applyUpdate').disabled = false;
  }
});

setInterval(() => {
  if (!$u('#app')?.classList.contains('hidden') && !updatePolling) void refreshUpdateStatus(false);
}, 5000);

setTimeout(() => void refreshUpdateStatus(false), 1200);
