const $ = s => document.querySelector(s);
const api = async (url, options={}) => {
  const response = await fetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  if(response.status===401){showLogin();throw new Error('Authentication required')}
  const text=await response.text(); const data=text?JSON.parse(text):null;
  if(!response.ok) throw new Error(data?.error||response.statusText); return data;
};
const showLogin=()=>{$('#login').classList.remove('hidden');$('#app').classList.add('hidden')};
const showApp=()=>{$('#login').classList.add('hidden');$('#app').classList.remove('hidden')};
let config;
async function boot(){
  const health=await fetch('/api/health').then(r=>r.json()); $('#health').textContent='オンライン';
  const host=location.hostname; $('#matterLink').href=`http://${host}:8283`;
  try{config=await api('/api/config');showApp();renderConfig();await renderRegistered()}catch(e){if(!health.authRequired)console.error(e)}
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:$('#password').value})});$('#loginError').textContent='';await boot()}catch(err){$('#loginError').textContent=err.message}});
$('#scan').addEventListener('click',async()=>{const b=$('#scan');b.disabled=true;b.textContent='スキャン中…';try{const data=await api('/api/scan',{method:'POST'});renderDiscovered(data.devices)}catch(e){alert(e.message)}finally{b.disabled=false;b.textContent='Bluetoothをスキャン'}});
function renderDiscovered(devices){const root=$('#discovered');root.innerHTML='';root.classList.toggle('empty',!devices.length);if(!devices.length){root.textContent='SwitchBotを検出できませんでした。';return}for(const d of devices){const n=$('#discoveredTpl').content.cloneNode(true);n.querySelector('h3').textContent=d.name||d.deviceType;n.querySelector('.meta').textContent=`${d.deviceType} · ${d.mac||d.id} · RSSI ${d.rssi??'-'}`;n.querySelector('.name').value=d.name||'SwitchBot';n.querySelector('.add').onclick=async ev=>{const article=ev.target.closest('article');try{await api('/api/devices',{method:'POST',body:JSON.stringify({id:d.id,name:article.querySelector('.name').value,mode:article.querySelector('.mode').value,matterType:'outlet',exposeMatter:true})});await renderRegistered()}catch(e){alert(e.message)}};root.append(n)}}
async function renderRegistered(){const {devices}=await api('/api/devices');const root=$('#registered');root.innerHTML='';root.classList.toggle('empty',!devices.length);if(!devices.length){root.textContent='登録デバイスなし';return}for(const d of devices){const n=$('#registeredTpl').content.cloneNode(true);const article=n.querySelector('article');article.querySelector('h3').textContent=d.name;article.querySelector('.meta').textContent=`${d.mode} · ${d.mac||d.id} · Matter: ${d.matterType}`;const p=article.querySelector('.matter');p.textContent=d.exposeMatter?'Matter ON':'Matter OFF';article.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=async()=>{const r=article.querySelector('.result');try{const data=await api(`/api/devices/${encodeURIComponent(d.id)}/${btn.dataset.action}`,{method:'POST'});r.textContent=JSON.stringify(data,null,2);r.classList.remove('hidden')}catch(e){r.textContent=e.message;r.classList.remove('hidden')}});article.querySelector('.toggleMatter').onclick=async()=>{await api(`/api/devices/${encodeURIComponent(d.id)}`,{method:'PATCH',body:JSON.stringify({exposeMatter:!d.exposeMatter})});await renderRegistered()};article.querySelector('.remove').onclick=async()=>{if(confirm(`${d.name} を削除しますか？`)){await api(`/api/devices/${encodeURIComponent(d.id)}`,{method:'DELETE'});await renderRegistered()}};root.append(n)}}
function renderConfig(){$('#hciDeviceId').value=config.hciDeviceId;$('#scanTimeoutMs').value=config.scanTimeoutMs;$('#apiFallback').checked=config.apiFallback;$('#scanOnStartup').checked=config.scanOnStartup}
$('#saveConfig').onclick=async()=>{config=await api('/api/config',{method:'PATCH',body:JSON.stringify({hciDeviceId:Number($('#hciDeviceId').value),scanTimeoutMs:Number($('#scanTimeoutMs').value),apiFallback:$('#apiFallback').checked,scanOnStartup:$('#scanOnStartup').checked})});renderConfig();if(config.restartRequired)alert('HCI/API経路の変更は再起動後に反映されます。')};
$('#diagnostics').onclick=async()=>{const d=await api('/api/diagnostics');$('#diag').textContent=JSON.stringify(d,null,2);$('#diag').classList.remove('hidden')};
$('#restart').onclick=async()=>{if(confirm('QnapHomeHubコンテナを再起動しますか？')){await api('/api/system/restart',{method:'POST'});location.reload()}};
boot().catch(e=>console.error(e));
