// Progressive QPKG-specific UI adjustments; keep existing control and admin layouts.
(() => {
  const hide = selector => document.querySelectorAll(selector).forEach(node => { node.style.display = 'none'; });
  const matter = document.querySelector('#matterLink');
  if (matter) matter.closest('section').style.display = 'none';
  const track = document.querySelector('#matterUpdateBadge');
  if (track) track.closest('.updateSubsection').style.display = 'none';
  hide('.toggleMatter, .matter, .deviceSettings .editMatterType, .deviceSettings .editMatterType + *, #applyMatterUpdate');
  const restart = document.querySelector('#restart');
  if (restart) {
    restart.disabled = true;
    restart.textContent = 'QTS App Centerから再起動';
  }
  const auto = document.querySelector('#autoUpdateEnabled');
  if (auto) auto.closest('label').style.display = 'none';
  const update = document.querySelector('#applyUpdate');
  if (update) update.style.display = 'none';
  const description = document.querySelector('.updateCard .sectionHead p');
  if (description) description.textContent = 'ネイティブQPKG試験版です。Web自己更新は未対応のためApp Centerを使用してください。';
})();
