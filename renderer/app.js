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
  $('btnInstallPodman').classList.add('hidden');
  if (!s.found) {
    b.classList.add('bad');
    $('podmanTitle').textContent = '● Podman not found';
    $('podmanDetail').innerHTML = 'jobkits needs Podman to run kits. Install it from ' +
      '<a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer">podman.io/docs/installation</a>, then restart jobkits.';
    $('btnInstallPodman').classList.remove('hidden');
    $('machinePanel').classList.add('hidden');
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
  refreshMachinePanel(s);
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
    if (r.reason === 'podman-not-found' || r.reason === 'machine-missing') refreshBanner();
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

/* ================= Podman machine wizard + settings (v0.2) ================= */
let host = null;
let machineCurrent = null;
let machineName = null;
const PRESETS = {
  light: { cpu: 2, mem: 4, disk: 30 },
  recommended: { cpu: 4, mem: 8, disk: 50 },
  power: { cpu: 8, mem: 16, disk: 100 },
};

function showResultError(el, r) {
  const msgs = (r && r.errors && r.errors.length) ? r.errors
    : [(r && r.guidance) || ('Failed: ' + ((r && r.reason) || 'unknown'))];
  el.textContent = msgs.join('\n');
  el.classList.remove('hidden');
}

async function getHost() { if (!host) host = await window.j.hostInfo(); return host; }

async function refreshMachinePanel(s) {
  const panel = $('machinePanel');
  if (window.j.platform === 'linux') {
    panel.classList.add('hidden');
    $('machineLinuxNote').classList.toggle('hidden', !s.found);
    return;
  }
  $('machineLinuxNote').classList.add('hidden');
  if (!s.found || !s.machine || s.machine.exists === null) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  if (!s.machine.exists) {
    $('machineSettingsBox').classList.add('hidden');
    $('wizardBox').classList.remove('hidden');
    await setupWizard();
  } else {
    $('wizardBox').classList.add('hidden');
    $('machineSettingsBox').classList.remove('hidden');
    await setupMachineSettings();
  }
}

/* --- wizard --- */
async function setupWizard() {
  const h = await getHost();
  $('wizCpu').max = Math.max(1, h.cpus);
  $('wizMem').max = Math.max(1, Math.floor(h.totalMemMiB / 1024));
  applyWizardPreset((document.querySelector('input[name="wizPreset"]:checked') || {}).value || 'recommended');
  updateWizardLabels();
}

function applyWizardPreset(name) {
  const p = PRESETS[name] || PRESETS.recommended;
  const maxCpu = Number($('wizCpu').max) || p.cpu;
  const maxMem = Number($('wizMem').max) || p.mem;
  const cpu = Math.min(p.cpu, maxCpu);
  const mem = Math.min(p.mem, maxMem);
  $('wizCpu').value = cpu;
  $('wizMem').value = mem;
  $('wizDisk').value = p.disk;
  const note = $('wizClampNote');
  if (cpu !== p.cpu || mem !== p.mem) {
    note.textContent = `Preset adjusted to fit this PC (${maxCpu} CPUs, ${maxMem} GiB RAM available).`;
    note.classList.remove('hidden');
  } else note.classList.add('hidden');
  updateWizardLabels();
}

function updateWizardLabels() {
  $('wizCpuVal').textContent = $('wizCpu').value;
  $('wizMemVal').textContent = $('wizMem').value + ' GiB';
  $('wizDiskVal').textContent = $('wizDisk').value + ' GiB';
}

document.querySelectorAll('input[name="wizPreset"]').forEach(r =>
  r.addEventListener('change', () => applyWizardPreset(r.value)));
['wizCpu', 'wizMem', 'wizDisk'].forEach(id =>
  $(id).addEventListener('input', () => {
    document.querySelectorAll('input[name="wizPreset"]').forEach(r => { r.checked = false; });
    $('wizClampNote').classList.add('hidden');
    updateWizardLabels();
  }));

$('btnCreateMachine').addEventListener('click', async () => {
  $('wizError').classList.add('hidden');
  $('machineLog').textContent = '';
  $('machineLog').classList.remove('hidden');
  $('btnCreateMachine').disabled = true;
  $('wizProgress').textContent = 'Creating machine… (the VM image download can take a while)';
  const cfg = {
    cpus: Number($('wizCpu').value),
    memoryMiB: Number($('wizMem').value) * 1024,
    diskSizeGiB: Number($('wizDisk').value),
    rootful: $('wizRootful').checked,
    timezone: 'local',
    now: $('wizNow').checked,
  };
  try {
    const r = await window.j.machineInit(cfg);
    if (r.ok) {
      $('wizProgress').textContent = cfg.now ? 'Machine created and started.' : 'Machine created.';
      log('[jobkits] podman machine created via wizard');
      await refreshBanner();
    } else {
      $('wizProgress').textContent = 'Machine creation failed.';
      showResultError($('wizError'), r);
    }
  } finally { $('btnCreateMachine').disabled = false; }
});

/* --- machine settings --- */
async function setupMachineSettings() {
  const h = await getHost();
  const insp = await window.j.machineInspect();
  if (!insp || !insp.ok) {
    machineCurrent = null;
    $('machineCurrent').textContent = (insp && insp.guidance) || 'Could not read machine settings.';
    return;
  }
  machineCurrent = insp;
  machineName = insp.name || null;
  const gib = insp.memoryMiB != null ? Math.round(insp.memoryMiB / 1024) : null;
  $('machineCurrent').textContent =
    `${insp.name || 'podman machine'} — ${insp.state || (insp.running ? 'running' : 'stopped')}` +
    ` · CPUs ${insp.cpus != null ? insp.cpus : 'unknown'}` +
    ` · Memory ${gib != null ? gib + ' GiB' : 'unknown'}` +
    ` · Disk ${insp.diskSizeGiB != null ? insp.diskSizeGiB + ' GiB' : 'unknown'}` +
    ` · ${insp.rootful == null ? 'root mode unknown' : (insp.rootful ? 'rootful' : 'rootless')}` +
    (insp.partial ? ' · (limited info from this Podman version)' : '');
  const maxCpu = Math.max(1, h.cpus);
  const maxMem = Math.max(1, Math.floor(h.totalMemMiB / 1024));
  $('setCpu').max = maxCpu;
  $('setMem').max = maxMem;
  $('setCpu').value = Math.min(insp.cpus != null ? insp.cpus : 4, maxCpu);
  $('setMem').value = Math.min(gib != null ? gib : 8, maxMem);
  if (insp.diskSizeGiB != null) $('setDisk').min = insp.diskSizeGiB;
  $('setDisk').value = insp.diskSizeGiB != null ? insp.diskSizeGiB : 50;
  $('setRootful').checked = insp.rootful === true;
  $('setStopConfirm').classList.add('hidden');
  updateSettingsLabels();
}

function updateSettingsLabels() {
  $('setCpuVal').textContent = $('setCpu').value;
  $('setMemVal').textContent = $('setMem').value + ' GiB';
  $('setDiskVal').textContent = $('setDisk').value + ' GiB';
}
['setCpu', 'setMem', 'setDisk'].forEach(id => $(id).addEventListener('input', updateSettingsLabels));

function gatherSetCfg() {
  return {
    name: machineName || undefined,
    cpus: Number($('setCpu').value),
    memoryMiB: Number($('setMem').value) * 1024,
    diskSizeGiB: Number($('setDisk').value),
    rootful: $('setRootful').checked,
  };
}

async function applyMachineSettings() {
  $('setError').classList.add('hidden');
  $('setStopConfirm').classList.add('hidden');
  $('machineLog').classList.remove('hidden');
  $('setMsg').textContent = 'Applying…';
  const r = await window.j.machineSet(gatherSetCfg());
  if (!r.ok) { $('setMsg').textContent = ''; showResultError($('setError'), r); return; }
  $('setMsg').textContent = r.noOp ? 'No changes — settings already match.' : 'Settings applied.';
  if ($('setRestart').checked) {
    $('setMsg').textContent += ' Starting machine…';
    const sr = await window.j.machineStart(machineName || undefined);
    $('setMsg').textContent = (r.noOp ? 'No changes.' : 'Settings applied.') + (sr.ok ? ' Machine running.' : ' Start failed: ' + (sr.reason || 'unknown'));
  }
  await refreshBanner();
}

$('btnApplyMachine').addEventListener('click', () => {
  $('setError').classList.add('hidden');
  if (machineCurrent && machineCurrent.running) {
    $('setStopConfirm').classList.remove('hidden');
    return;
  }
  applyMachineSettings();
});
$('btnStopApply').addEventListener('click', async () => {
  $('setStopConfirm').classList.add('hidden');
  $('setMsg').textContent = 'Stopping machine…';
  const sr = await window.j.machineStop(machineName || undefined);
  if (!sr.ok) { $('setMsg').textContent = ''; showResultError($('setError'), sr); return; }
  await applyMachineSettings();
});

/* streamed machine operation output + state */
window.j.onMachineLog(({ line }) => {
  const ml = $('machineLog');
  ml.classList.remove('hidden');
  ml.textContent += line + '\n';
  if (ml.textContent.length > 60000) ml.textContent = ml.textContent.slice(-40000);
  ml.scrollTop = ml.scrollHeight;
});
window.j.onMachineProgress(({ op, state }) => {
  if (op === 'init') $('wizProgress').textContent = state === 'running' ? 'Creating machine…' : (state === 'done' ? 'Machine created.' : 'Machine creation failed.');
  if (op === 'set' && state === 'running') $('setMsg').textContent = 'Applying…';
$('btnInstallPodman').addEventListener('click', async () => {
  $('btnInstallPodman').disabled = true;
  $('podmanDetail').textContent = 'Installing Podman… this may take a few minutes.';
  try {
    const r = await window.j.installPodman();
    if (r && r.ok) {
      $('podmanDetail').textContent = 'Podman installed. Restarting check…';
    } else {
      $('podmanDetail').innerHTML = 'Install failed: ' + ((r && (r.guidance || r.reason)) || 'unknown') + '<br>See <a href="https://podman.io/docs/installation" target="_blank">podman.io/docs/installation</a>.';
    }
  } catch (e) {
    $('podmanDetail').textContent = 'Install failed: ' + e;
  }
  $('btnInstallPodman').disabled = false;
  await refreshBanner();
});


});

init();
