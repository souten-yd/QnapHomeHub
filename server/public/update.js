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
    idle: '待機中', checking: '確認中', preparing: '更新準備中', pulling: 'イメージ取得中',
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
    badge.textContent = 'RELEASE ERROR';
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
  if (status.lastError) message.textContent = `HomeHub更新確認: ${status.lastError}`;
  else if (status.busy && status.phase !== 'idle') message.textContent = `${phaseLabel(status.phase)}。更新中はHomeHubが一時的に切断されます。`;
  else if (status.updateAvailable) message.textContent = `GitHub Release ${status.latestTag} を適用できます。`;
  else if (status.latestVersion) message.textContent = 'HomeHubは最新のstable Releaseです。';
  else message.textContent = 'GitHub Releasesのstable版を確認します。';

  const link = $u('#releaseLink');
  if (status.releaseUrl) {
    link.href = status.releaseUrl;
    link.classList.remove('hidden');
  } else link.classList.add('hidden');

  renderMatterbridgeUpdate(status.matterbridge || {}, Boolean(status.busy));
}

function renderMatterbridgeUpdate(matter, busy) {
  $u('#matterUpdateCurrent').textContent = matter.currentVersion ? `v${matter.currentVersion}` : '-';
  $u('#matterUpdateTested').textContent = matter.testedVersion ? `v${matter.testedVersion}` : '未取得';
  $u('#matterUpdatePhase').textContent = phaseLabel(matter.phase);
  $u('#applyMatterUpdate').disabled = busy || !matter.updateAvailable;

  const badge = $u('#matterUpdateBadge');
  if (matter.phase === 'error') {
    badge.textContent = 'TRACK ERROR';
    badge.className = 'pill debugWarn';
  } else if (matter.updateAvailable) {
    badge.textContent = 'TESTED UPDATE';
    badge.className = 'pill debugWarn';
  } else if (matter.testedVersion) {
    badge.textContent = 'TESTED CURRENT';
    badge.className = 'pill debugGood';
  } else {
    badge.textContent = 'CHECK';
    badge.className = 'pill';
  }

  const message = $u('#matterUpdateMessage');
  if (matter.lastError) message.textContent = `Matterbridge確認: ${matter.lastError}`;
  else if (matter.phase && !['idle', 'success'].includes(matter.phase)) message.textContent = `${phaseLabel(matter.phase)}。失敗時は直前のMatterbridgeへ自動ロールバックします。`;
  else if (matter.updateAvailable) message.textContent = `QnapHomeHubとのCIに通ったMatterbridge v${matter.testedVersion || '-'}へ更新できます。`;
  else if (matter.testedVersion) message.textContent = `Matterbridge v${matter.testedVersion} はQnapHomeHub結合テスト済みです。`;
  else message.textContent = 'CI検証済みMatterbridge stableを確認します。';
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

async function waitForUpdateCompletion(component) {
  if (updatePolling) return;
  updatePolling = true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await refreshUpdateStatus(false);
    if (!status) continue;
    if (component === 'matterbridge') {
      const matter = status.matterbridge || {};
      if (!status.busy && matter.phase === 'success') {
        $u('#matterUpdateMessage').textContent = 'Matterbridge更新完了。QnapHomeHub pluginの再同期を待っています。';
        break;
      }
      if (!status.busy && matter.phase === 'error') break;
    } else {
      if (!status.busy && status.phase === 'success') {
        $u('#updateMessage').textContent = 'HomeHub更新完了。新しいUIを再読み込みします…';
        setTimeout(() => location.reload(), 1200);
        break;
      }
      if (!status.busy && status.phase === 'error') break;
    }
  }
  updatePolling = false;
}

$u('#checkUpdate')?.addEventListener('click', async () => {
  try {
    $u('#updateMessage').textContent = 'HomeHub Releaseと検証済みMatterbridgeを確認しています…';
    $u('#matterUpdateMessage').textContent = 'GHCRの検証済みMatterbridgeを確認しています…';
    renderUpdate(await updateApi('/api/update/check', { method: 'POST', body: '{}' }));
  } catch (error) {
    $u('#updateMessage').textContent = `更新確認失敗: ${error.message}`;
  }
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
  if (!confirm(`${status.latestTag}へHomeHub一式を更新しますか？\n失敗した場合は旧Dockerイメージへ自動ロールバックします。`)) return;
  try {
    $u('#applyUpdate').disabled = true;
    $u('#updateMessage').textContent = `${status.latestTag}の更新を開始します…`;
    await updateApi('/api/update/apply', { method: 'POST', body: JSON.stringify({ tag: status.latestTag }) });
    void waitForUpdateCompletion('release');
  } catch (error) {
    $u('#updateMessage').textContent = `更新開始失敗: ${error.message}`;
    $u('#applyUpdate').disabled = false;
  }
});

$u('#applyMatterUpdate')?.addEventListener('click', async () => {
  const matter = latestUpdateStatus?.matterbridge;
  if (!matter?.updateAvailable) return;
  if (!confirm(`CI検証済みMatterbridge v${matter.testedVersion || '-'}へ更新しますか？\nHomeHub本体とBLE設定は変更しません。`)) return;
  try {
    $u('#applyMatterUpdate').disabled = true;
    $u('#matterUpdateMessage').textContent = 'Matterbridge検証済み最新版へ更新を開始します…';
    await updateApi('/api/update/apply', { method: 'POST', body: JSON.stringify({ tag: 'matterbridge-tested' }) });
    void waitForUpdateCompletion('matterbridge');
  } catch (error) {
    $u('#matterUpdateMessage').textContent = `Matterbridge更新開始失敗: ${error.message}`;
    $u('#applyMatterUpdate').disabled = false;
  }
});

setInterval(() => {
  if (!$u('#app')?.classList.contains('hidden') && !updatePolling) void refreshUpdateStatus(false);
}, 5000);

setTimeout(() => void refreshUpdateStatus(false), 1200);
