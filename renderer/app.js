'use strict';
/* jobkits renderer: kit list comes from manifests via IPC, so new kits
 * appear automatically. The kit web UI loads in the <webview> once main
 * reports phase 'running' with a webUrl.
 */
const $ = (id) => document.getElementById(id);
const logEl = $('log');
let kits = [];
let selected = null;
let running = new Set();
let psTimer = null;

function log(line) {
  logEl.textContent += line + '\n';
  if (logEl.textContent.length > 120000) logEl.textContent = logEl.textContent.slice(-80000);
  logEl.scrollTop = logEl.scrollHeight;
}

async function refreshBanner() {
  const b = $('podmanBanner');
  const s = await window.j.podmanStatus();
  b.classList.remove('ok', 'bad', 'warn');
  if (!s.found) {
    b.classList.add('bad');
    $('podmanTitle').textContent = '● Podman not found';
    $('podmanDetail').innerHTML = 'jobkits needs Podman to run kits. Install it from ' +
      '<a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer">podman.io/docs/installation</a>' +
      (window.j.platform === 'win32' ? '<br>Then run <code>podman machine init</code> and <code>podman machine start</code> once in a terminal.' : '');
    return s;
  }
  let detail = (s.version || '') + ' · compose: ' + (s.compose && s.compose.provider ? s.compose.provider : 'NOT FOUND');
  let cls = 'ok';
  if (s.machine) {
    if (!s.machine.exists) { cls = 'warn'; detail += '<br>' + s.machine.guidance; }
    else if (!s.machine.running) { cls = 'warn'; detail += '<br>machine stopped — Start will run <code>podman machine start</code>'; }
    else detail += ' · machine running (' + (s.machine.name || 'default') + ')';
  }
  if (!s.compose || !s.compose.provider) { cls = 'warn'; detail += '<br>' + ((s.compose && s.compose.guidance) || 'no compose provider'); }
  b.classList.add(cls);
  $('podmanTitle').textContent = (cls === 'ok' ? '● Podman ready' : '● Podman needs attention');
  $('podmanDetail').innerHTML = detail;
  return s;
}

function selectKit(id) {
  selected = id;
  document.querySelectorAll('.kit-card').forEach(c => c.classList.toggle('on', c.dataset.id === id));
  $('kitPanel').classList.toggle('hidden', !id);
  updateButtons();
  refreshPs();
  refreshSettings();
}

function updateButtons() {
  const isRunning = selected && running.has(selected);
  $('btnStart').disabled = !selected || isRunning;
  $('btnStop').disabled = !selected || !isRunning;
  $('btnOpen').disabled = !selected || !isRunning;
}

async function refreshPs() {
  if (!selected) return;
  const kit = kits.find(k => k.id === selected);
  const box = $('services');
  const r = await window.j.ps(selected).catch(() => null);
  const byService = new Map(((r && r.services) || []).map(s => [s.service, s]));
  box.innerHTML = '';
  for (const svc of kit.services) {
    const info = byService.get(svc);
    const row = document.createElement('div');
    row.className = 'svc';
    const state = info ? (info.health && info.health !== '' ? info.health : info.state) : 'not created';
    row.innerHTML = '<span class="dot ' + (info ? (info.health || info.state) : '') + '"></span><span></span><span class="svc-state"></span>';
    row.children[1].textContent = svc;
    row.children[2].textContent = state;
    box.appendChild(row);
  }
}

async function refreshSettings() {
  const s = await window.j.getSettings();
  $('llmBase').value = s.llm.LLM_BASE_URL || '';
  $('llmKey').value = s.llm.LLM_API_KEY || '';
  $('llmModel').value = s.llm.LLM_MODEL || '';
  const entry = (s.kits || []).find(k => k.id === selected);
  $('ports').textContent = entry ? Object.entries(entry.ports).map(([k, v]) => `${k}=${v}`).join('\n') : '';
}

async function init() {
  kits = await window.j.listKits();
  const list = $('kitList');
  list.innerHTML = '';
  for (const kit of kits) {
    const card = document.createElement('div');
    card.className = 'kit-card';
    card.dataset.id = kit.id;
    card.innerHTML = '<div class="kit-name"></div><div class="kit-pin"></div><div class="kit-desc"></div>';
    card.children[0].textContent = kit.name;
    card.children[1].textContent = 'pin ' + kit.pinnedCommit.slice(0, 8) + ' · ' + kit.repo.replace('https://github.com/', '');
    card.children[2].textContent = kit.description;
    card.addEventListener('click', () => selectKit(kit.id));
    list.appendChild(card);
  }
  if (kits.length) selectKit(kits[0].id);
  await refreshBanner();
  psTimer = setInterval(refreshPs, 5000);
}

window.j.onLog(({ id, stream, line }) => log(`[${id}/${stream}] ${line}`));
window.j.onState(({ id, phase, webUrl, elapsedMs }) => {
  if (id !== selected) return;
  const label = {
    preparing: 'Preparing…', starting: 'Starting stack (compose up)…',
    'waiting-health': 'Waiting for health' + (elapsedMs ? ` (${Math.round(elapsedMs / 1000)}s)` : '') + '…',
    running: 'Running', stopping: 'Stopping…', wiping: 'Wiping data…', stopped: 'Stopped',
  }[phase] || phase;
  $('phase').textContent = label;
  if (phase === 'running' && webUrl) {
    running.add(id);
    const view = $('kitView');
    if (view.getAttribute('src') !== webUrl) view.setAttribute('src', webUrl);
    view.classList.remove('hidden');
    $('placeholder').classList.add('hidden');
    window.j.logsStart(id).catch(() => {});
  }
  if (phase === 'stopped') {
    running.delete(id);
    $('kitView').classList.add('hidden');
    $('placeholder').classList.remove('hidden');
  }
  updateButtons();
  refreshPs();
});

$('btnStart').addEventListener('click', async () => {
  if (!selected) return;
  $('phase').textContent = 'Starting…';
  $('btnStart').disabled = true;
  const r = await window.j.start(selected);
  if (!r.ok) {
    log(`[jobkits] start failed: ${r.reason || 'unknown'}${r.guidance ? ' — ' + r.guidance : ''}`);
    $('phase').textContent = 'Failed: ' + (r.reason || 'unknown');
    if (r.reason === 'podman-not-found') refreshBanner();
  }
  updateButtons();
});
$('btnStop').addEventListener('click', async () => { if (selected) await window.j.stop(selected); });
$('btnWipe').addEventListener('click', async () => {
  if (!selected) return;
  const r = await window.j.wipe(selected);
  if (r && r.reason === 'cancelled') log('[jobkits] wipe cancelled');
});
$('btnOpen').addEventListener('click', () => { if (selected) window.j.openExternal(selected); });
$('btnSaveSettings').addEventListener('click', async () => {
  await window.j.setSettings({ LLM_BASE_URL: $('llmBase').value, LLM_API_KEY: $('llmKey').value, LLM_MODEL: $('llmModel').value });
  $('settingsMsg').textContent = 'saved — applies on next Start';
});
$('btnClearLog').addEventListener('click', () => { logEl.textContent = ''; });

init();
