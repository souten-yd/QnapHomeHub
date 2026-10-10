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
  const description = document.querySelector('.updateCard .sectionHead p');
  if (description) description.textContent =
    'ネイティブQPKG試験版です。Web自己更新は未対応のためApp Centerを使用してください。';
})();
