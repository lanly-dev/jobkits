'use strict';
/* jobkits -- main process.
 * A Podman launcher for self-hosted services ("kits"). Each kit is a folder
 * under kits/ with a kit.json manifest + compose reference copy. On Start:
 * ensure upstream source checkout (lib/source) -> generate .env (lib/envfile)
 * -> ensure podman machine -> podman compose up -> poll health (lib/health)
 * -> load the kit web UI in the <webview>.
 * Podman missing is a supported state: everything degrades to guidance.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const kits = require('./lib/kits');
const podman = require('./lib/podman');
const envfile = require('./lib/envfile');
const source = require('./lib/source');
const health = require('./lib/health');

const SMOKE = process.env.JOBKITS_SMOKE === '1';
let win = null;
const logChildren = new Map(); // kitId -> log-follow child process
const busy = new Set();         // kitIds with an in-flight start/stop

function userDataDir() { return app.getPath('userData'); }
function statePath() { return path.join(userDataDir(), 'jobkits-state.json'); }
function kitSrcDir(id) { return path.join(userDataDir(), 'kits', id, 'src'); }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function log(id, line, stream = 'jobkits') { send('kit:log', { id, stream, line }); }

async function kitContext(id) {
  const kit = kits.getKit(id);
  const state = envfile.loadState(statePath());
  const kitState = state.kits[id] || {};
  const envValues = kitState.secrets || kitState.ports
    ? envfile.buildEnvValues(kit, { secrets: kitState.secrets || {}, ports: kitState.ports || {} }, state.settings)
    : {};
  return { kit, srcDir: kitSrcDir(id), envValues, state };
}

function effectivePorts(kit, kitState) {
  const ports = { ...kit.defaultPorts, ...((kitState && kitState.ports) || {}) };
  return {
    ports,
    webUrl: `http://127.0.0.1:${ports[kit.webPortEnv]}`,
    healthPort: ports[kit.healthPortEnv],
  };
}

async function startKit(id) {
  if (busy.has(id)) return { ok: false, reason: 'busy', guidance: 'An operation is already in progress for this kit.' };
  busy.add(id);
  try {
    const kit = kits.getKit(id);
    const srcDir = kitSrcDir(id);
    send('kit:state', { id, phase: 'preparing' });

    const status = await podman.getStatus();
    if (!status.found) { log(id, podman.NOT_FOUND.guidance); return { ...podman.NOT_FOUND }; }

    const machine = await podman.ensureMachine();
    if (!machine.ok) { log(id, machine.guidance || 'podman machine could not be started'); return machine; }

    log(id, `ensuring source checkout (${kit.repo} @ ${kit.pinnedCommit.slice(0, 8)}) in ${srcDir}`);
    const src = await source.ensureSource(kit, srcDir, { onLine: ({ line }) => log(id, line, 'git') });
    if (!src.ok) { log(id, src.guidance || 'source checkout failed'); return src; }

    const state = envfile.loadState(statePath());
    const envRes = await envfile.ensureKitEnv({ kit, srcDir, statePath: statePath(), settings: state.settings });
    log(id, envRes.created ? 'generated .env (new secrets/ports persisted)' : 'reusing persisted secrets/ports from state');
    const ctx = { kit, srcDir, envValues: envRes.values };

    send('kit:state', { id, phase: 'starting' });
    log(id, 'podman compose up -d --build (first run builds images — this can take several minutes)');
    const up = await podman.composeUp(ctx, { onLine: ({ stream, line }) => log(id, line, stream) });
    if (!up.ok) { log(id, 'compose up failed — see output above'); return { ok: false, reason: 'compose-up-failed', code: up.code, guidance: up.guidance || 'compose up failed' }; }

    const { webUrl, healthPort } = effectivePorts(kit, envfile.loadState(statePath()).kits[id]);
    send('kit:state', { id, phase: 'waiting-health', webUrl });
    log(id, `waiting for ${kit.name} health at 127.0.0.1:${healthPort}${kit.healthPath} (up to ~5 min)`);
    const h = await health.waitForHealth({
      port: healthPort, healthPath: kit.healthPath,
      onProgress: ({ elapsedMs }) => send('kit:state', { id, phase: 'waiting-health', webUrl, elapsedMs }),
    });
    if (!h.ok) {
      log(id, 'health check timed out — the stack may still be starting; logs will show where it is stuck');
      return { ok: false, reason: 'health-timeout', webUrl, guidance: 'The kit did not answer its health endpoint within ~5 minutes. Check the log pane / compose logs.' };
    }
    log(id, `${kit.name} is healthy — loading ${webUrl}`);
    send('kit:state', { id, phase: 'running', webUrl });
    return { ok: true, webUrl };
  } finally {
    busy.delete(id);
  }
}

async function stopKit(id, wipe = false) {
  if (busy.has(id)) return { ok: false, reason: 'busy' };
  busy.add(id);
  try {
    stopLogs(id);
    const ctx = await kitContext(id);
    send('kit:state', { id, phase: wipe ? 'wiping' : 'stopping' });
    const r = await podman.composeDown(ctx, { wipe, onLine: ({ stream, line }) => log(id, line, stream) });
    send('kit:state', { id, phase: 'stopped' });
    return r.ok ? { ok: true } : r;
  } finally {
    busy.delete(id);
  }
}

function stopLogs(id) {
  const child = logChildren.get(id);
  if (child) { try { child.kill(); } catch { /* already gone */ } logChildren.delete(id); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 660,
    backgroundColor: '#0b0e14', title: 'jobkits',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  ipcMain.handle('kits:list', () => kits.listKits().map(k => {
    const state = envfile.loadState(statePath());
    const { webUrl } = effectivePorts(k, state.kits[k.id]);
    return { ...kits.publicKit(k), webUrl, srcDir: kitSrcDir(k.id), srcCheckedOut: fs.existsSync(path.join(kitSrcDir(k.id), '.git')) };
  }));

  ipcMain.handle('podman:status', () => podman.getStatus());

  /* --- Podman machine wizard + settings GUI (v0.2) ---
   * Init/set are user-driven from the GUI (Start never auto-inits). Both
   * stream output lines as 'machine:log' and state as 'machine:progress'. */
  let machineBusy = false;
  const machineLog = (op) => ({ stream, line }) => send('machine:log', { op, stream, line });
  async function machineOp(op, fn) {
    if (machineBusy) return { ok: false, reason: 'busy', guidance: 'Another machine operation is already in progress.' };
    machineBusy = true;
    send('machine:progress', { op, state: 'running' });
    try {
      const r = await fn();
      send('machine:progress', { op, state: r && r.ok ? 'done' : 'failed', reason: (r && r.reason) || null });
      return r;
    } finally { machineBusy = false; }
  }
  ipcMain.handle('podman:hostInfo', () => podman.hostInfo());
  ipcMain.handle('podman:machineInspect', (_e, name) => podman.machineInspect(name || undefined));
  ipcMain.handle('podman:machineInit', (_e, cfg) => machineOp('init', () => podman.machineInit(cfg || {}, machineLog('init'))));
  ipcMain.handle('podman:machineSet', (_e, cfg) => machineOp('set', () => podman.machineSet(cfg || {}, machineLog('set'))));
  ipcMain.handle('podman:machineStop', (_e, name) => machineOp('stop', () => podman.machineStop(name || undefined)));
  ipcMain.handle('podman:machineStart', (_e, name) => machineOp('start', () => podman.machineStart(name || undefined)));

  ipcMain.handle('kit:ps', async (_e, id) => {
    const ctx = await kitContext(id);
    if (!fs.existsSync(ctx.srcDir)) return { ok: true, services: [], note: 'not started yet' };
    return podman.composePs(ctx);
  });

  ipcMain.handle('kit:start', (_e, id) => startKit(id));
  ipcMain.handle('kit:stop', (_e, id) => stopKit(id, false));

  ipcMain.handle('kit:wipe', async (_e, id) => {
    const kit = kits.getKit(id);
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Wipe data'], defaultId: 0, cancelId: 0,
      title: 'Wipe ' + kit.name + ' data?',
      message: `This runs compose down -v and permanently deletes ${kit.name}'s database, search index and stored files (named volumes). The source checkout and your jobkits secrets/ports are kept.`,
    });
    if (r.response !== 1) return { ok: false, reason: 'cancelled' };
    return stopKit(id, true);
  });

  ipcMain.handle('kit:logsStart', async (_e, id) => {
    stopLogs(id);
    const ctx = await kitContext(id);
    const res = await podman.composeLogs(ctx, { follow: true, tail: 200, onLine: ({ stream, line }) => log(id, line, stream) });
    if (res && res.child) { logChildren.set(id, res.child); return { ok: true }; }
    return res && res.ok ? { ok: true } : (res || { ok: false });
  });
  ipcMain.handle('kit:logsStop', (_e, id) => { stopLogs(id); return { ok: true }; });

  ipcMain.handle('kit:openExternal', (_e, id) => {
    const kit = kits.getKit(id);
    const state = envfile.loadState(statePath());
    const { webUrl } = effectivePorts(kit, state.kits[id]);
    return shell.openExternal(webUrl);
  });

  ipcMain.handle('settings:get', () => {
    const state = envfile.loadState(statePath());
    const kitList = kits.listKits().map(k => ({
      id: k.id,
      ports: { ...k.defaultPorts, ...((state.kits[k.id] || {}).ports || {}) },
    }));
    return { llm: state.settings || {}, kits: kitList };
  });
  ipcMain.handle('settings:set', (_e, llm) => {
    const state = envfile.loadState(statePath());
    const clean = {};
    for (const key of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) {
      clean[key] = typeof (llm || {})[key] === 'string' ? llm[key].trim() : '';
    }
    state.settings = clean;
    envfile.saveState(statePath(), state);
    return { ok: true, llm: clean };
  });

  createWindow();

  if (SMOKE) {
    const status = await podman.getStatus();
    const list = kits.listKits().map(k => k.id);
    // exercise the v0.2 machine paths under (possibly) missing podman: they
    // must resolve gracefully, never throw, so the wizard can render.
    const host = podman.hostInfo();
    const insp = await podman.machineInspect();
    const initTry = await podman.machineInit({ cpus: 1, memoryMiB: 1024, diskSizeGiB: 10 });
    const setTry = await podman.machineSet({ cpus: 1 });
    console.log('[jobkits-smoke] podman found=' + status.found + ' reason=' + (status.reason || 'n/a') + ' kits=' + JSON.stringify(list)
      + ' hostCpus=' + host.cpus + ' inspect=' + (insp.ok ? 'ok' : insp.reason) + ' init=' + (initTry.ok ? 'ok' : initTry.reason) + ' set=' + (setTry.ok ? 'ok' : setTry.reason));
    setTimeout(() => { console.log('[jobkits-smoke] OK — quitting'); app.quit(); }, 3000);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const id of [...logChildren.keys()]) stopLogs(id); });
