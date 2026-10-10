// Progressive QPKG-specific UI adjustments; preserve existing control and admin layouts.
(() => {
  const stylesheet = document.createElement('style');
  // Device cards are rendered after this script: CSS is intentional.
  stylesheet.textContent = `
    .toggleMatter, .matter, .deviceSettings label:has(.editMatterType),
    .updateSubsection, #applyMatterUpdate { display: none !important; }
  `;
  document.head.append(stylesheet);
  const matter = document.querySelector('#matterLink');
  if (matter) matter.closest('section').style.display = 'none';
  const restart = document.querySelector('#restart');
  if (restart) {
    restart.disabled = true;
    restart.textContent = 'QTS App Centerから再起動';
  }
  const auto = document.querySelector('#autoUpdateEnabled');
  if (auto) auto.closest('label').style.display = 'none';
  const update = document.querySelector('#applyUpdate');
  if (update) update.style.display = 'none';
  // Explicit read-only migration diagnostics; no browser-initiated Docker mutations.
  const parent = document.querySelector('#app');
  if (parent) {
    const section = document.createElement('section');
    section.className = 'card';
    const heading = document.createElement('h2');
    heading.textContent = 'QPKG / Docker共存の確認';
    const note = document.createElement('p');
    note.textContent = 'SelfCare共有radioは維持します。構成確認は読み取り専用です。';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Docker構成を確認';
    const output = document.createElement('pre');
    output.textContent = '確認ボタンを押してください。';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/migration/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('認証または診断に失敗しました');
        const status = await response.json();
        output.textContent = status.ok
          ? 'SelfCare radio: 稼働中 / 保護対象\\n' +
            Object.entries(status.web_services || {}).map(([name, item]) =>
              name + ': ' + (item.running ? '稼働中' : '停止中') + ', 再起動=' + item.restart).join('\\n')
          : '要確認: ' + (status.error || '診断できませんでした');
      } catch (error) { output.textContent = '診断失敗: ' + error.message; }
      finally { button.disabled = false; }
    };
    section.append(heading, note, button, output);
    parent.prepend(section);
  }
  const description = document.querySelector('.updateCard .sectionHead p');
  if (description) description.textContent =
    'ネイティブQPKG試験版です。Web自己更新は未対応のためApp Centerを使用してください。';
})();
