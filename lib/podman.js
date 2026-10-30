'use strict';
/* Podman driver. EVERYTHING here degrades gracefully when podman is absent:
 * functions resolve to { ok:false, reason:'podman-not-found', guidance }
 * instead of throwing — a machine without Podman is a supported state (the
 * UI shows install guidance), not a crash.
 *
 * Compose provider: prefer `podman compose` (Podman >= 4.7 delegates to a
 * compose provider such as docker-compose / podman-compose and understands
 * depends_on service_healthy / service_completed_successfully, which
 * freehire's compose file relies on). Fall back to a bare `podman-compose`
 * binary when `podman compose` is unavailable.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const INSTALL_URL = 'https://podman.io/docs/installation';

const NOT_FOUND = Object.freeze({
  ok: false,
  reason: 'podman-not-found',
  guidance: `Podman was not found on this machine. Install it from ${INSTALL_URL}, then restart jobkits — ` +
    'the built-in setup wizard will create and start the Podman machine for you (no terminal needed).',
});

function candidatePaths(platform = process.platform, env = process.env) {
  const out = [];
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    out.push(path.win32.join(pf, 'RedHat', 'Podman', 'podman.exe'));
    out.push(path.win32.join(pf86, 'RedHat', 'Podman', 'podman.exe'));
    if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Podman', 'podman.exe'));
  } else if (platform === 'darwin') {
    out.push('/opt/podman/bin/podman', '/usr/local/bin/podman', '/opt/homebrew/bin/podman');
  } else {
    out.push('/usr/bin/podman', '/usr/local/bin/podman');
  }
  return out;
}

function findOnPath(name, env = process.env, platform = process.platform) {
  const pathEnv = env.PATH || env.Path || '';
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext.toLowerCase());
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/* Locate the podman binary: explicit override, PATH, then known install dirs. */
function findPodman({ env = process.env, platform = process.platform } = {}) {
  if (env.JOBKITS_PODMAN && fs.existsSync(env.JOBKITS_PODMAN)) return env.JOBKITS_PODMAN;
  const onPath = findOnPath(platform === 'win32' ? 'podman' : 'podman', env, platform);
  if (onPath) return onPath;
  for (const p of candidatePaths(platform, env)) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function exec(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout || 30000, windowsHide: true, env: opts.env || process.env, cwd: opts.cwd },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, code: err.code ?? 1, stdout: String(stdout || ''), stderr: String(stderr || err.message) });
        resolve({ ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

/* Full status: binary, version, machine state (win32/darwin), compose provider. */
async function getStatus(opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND, found: false, platform: opts.platform || process.platform };
  const status = { ok: true, found: true, bin, platform: opts.platform || process.platform, machine: null, compose: null };
  const ver = await exec(bin, ['--version']);
  status.version = ver.ok ? ver.stdout.trim() : null;
  if (status.platform === 'win32' || status.platform === 'darwin') {
    const ml = await exec(bin, ['machine', 'list', '--format', 'json']);
    if (ml.ok) {
      try {
        const machines = JSON.parse(ml.stdout || '[]');
        const running = machines.find(m => m.Running);
        const def = machines.find(m => m.Default) || machines[0];
        status.machine = {
          exists: machines.length > 0,
          running: !!running,
          name: (running || def || {}).Name || null,
          guidance: machines.length === 0
            ? 'No Podman machine exists yet. Use the "Set up Podman machine" wizard below — jobkits creates it for you, no terminal needed.'
            : (!running ? 'Podman machine is stopped. jobkits runs `podman machine start` for you on Start.' : null),
        };
      } catch { status.machine = { exists: null, running: null, parseError: true }; }
    }
  }
  status.compose = await detectCompose(bin, opts);
  return status;
}

/* Ensure a podman machine is running on win32/darwin. No-op elsewhere. */
async function ensureMachine(opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return { ok: true, skipped: true };
  const st = await getStatus(opts);
  if (!st.machine || st.machine.exists === null) return { ok: true, unknown: true };
  if (!st.machine.exists) {
    return { ok: false, reason: 'machine-missing', guidance: 'No Podman machine exists yet. jobkits does NOT create one automatically from Start — open the "Set up Podman machine" wizard in the app (it downloads a Linux VM image and takes a few minutes), then press Start again.' };
  }
  if (st.machine.running) return { ok: true, alreadyRunning: true };
  const r = await exec(bin, ['machine', 'start'], { timeout: 180000 });
  return r.ok ? { ok: true, started: true } : { ok: false, reason: 'machine-start-failed', stderr: r.stderr, guidance: '`podman machine start` failed — try running it in a terminal to see the full error.' };
}

let composeCache = null;
async function detectCompose(bin, opts = {}) {
  if (composeCache) return composeCache;
  const v = await exec(bin, ['compose', 'version']);
  if (v.ok) composeCache = { provider: 'podman-compose-builtin', bin, prefixArgs: ['compose'], version: v.stdout.trim() || v.stderr.trim() };
  else {
    const pc = findOnPath('podman-compose', opts.env || process.env, opts.platform || process.platform);
    if (pc) {
      const pv = await exec(pc, ['--version']);
      composeCache = { provider: 'podman-compose', bin: pc, prefixArgs: [], version: pv.ok ? (pv.stdout.trim() || pv.stderr.trim()) : null };
    } else {
      composeCache = { provider: null, guidance: '`podman compose` is unavailable and no `podman-compose` binary was found. Upgrade Podman to >= 4.7 or install podman-compose.' };
    }
  }
  return composeCache;
}

/* Streamed compose runner: lines go to onLine({stream, line}); resolves on close. */
function runCompose(ctx, subArgs, { onLine, env } = {}) {
  return new Promise(async (resolve) => {
    const bin = findPodman();
    if (!bin) return resolve({ ...NOT_FOUND });
    const compose = await detectCompose(bin);
    if (!compose.provider) return resolve({ ok: false, reason: 'compose-not-found', guidance: compose.guidance });
    const args = [...compose.prefixArgs, '--project-name', 'jobkits-' + ctx.kit.id, ...subArgs];
    const child = spawn(compose.bin, args, { cwd: ctx.srcDir, env: { ...process.env, ...(env || {}), ...(ctx.envValues || {}) }, windowsHide: true });
    const emit = (stream) => (buf) => {
      if (!onLine) return;
      for (const line of buf.toString('utf8').split(/\r?\n/)) if (line) onLine({ stream, line });
    };
    child.stdout.on('data', emit('stdout'));
    child.stderr.on('data', emit('stderr'));
    child.on('error', (err) => resolve({ ok: false, reason: 'spawn-failed', error: String(err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
    if (ctx.registerChild) ctx.registerChild(child);
  });
}

function composeUp(ctx, opts = {}) {
  return runCompose(ctx, ['up', '-d', '--build'], opts);
}
function composeDown(ctx, { wipe = false, ...opts } = {}) {
  return runCompose(ctx, wipe ? ['down', '-v'] : ['down'], opts);
}

/* Parsed `compose ps`: tolerates a JSON array OR newline-delimited objects. */
async function composePs(ctx) {
  const bin = findPodman();
  if (!bin) return { ...NOT_FOUND, services: [] };
  const compose = await detectCompose(bin);
  if (!compose.provider) return { ok: false, reason: 'compose-not-found', guidance: compose.guidance, services: [] };
  const r = await exec(compose.bin, [...compose.prefixArgs, '--project-name', 'jobkits-' + ctx.kit.id, 'ps', '--format', 'json'],
    { cwd: ctx.srcDir, env: { ...process.env, ...(ctx.envValues || {}) } });
  if (!r.ok) return { ok: false, reason: 'ps-failed', stderr: r.stderr, services: [] };
  const services = [];
  const text = r.stdout.trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      for (const s of Array.isArray(parsed) ? parsed : [parsed]) services.push(normalizePs(s));
    } catch {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { services.push(normalizePs(JSON.parse(line))); } catch { /* skip unparseable line */ }
      }
    }
  }
  return { ok: true, services };
}

function normalizePs(s) {
  return {
    service: s.Service || s.service || s.Name || 'unknown',
    state: String(s.State || s.state || '').toLowerCase(),
    health: String(s.Health || s.health || '').toLowerCase(),
    status: s.Status || s.status || '',
    ports: s.Ports || s.Publishers || [],
  };
}

/* Logs: non-follow returns a promise of recent lines; follow=true returns the
 * child process immediately so the caller can stream and kill it. */
function composeLogs(ctx, { onLine, follow = false, tail = 300 } = {}) {
  const bin = findPodman();
  if (!bin) { const r = Promise.resolve({ ...NOT_FOUND }); r.child = null; return r; }
  return (async () => {
    const compose = await detectCompose(bin);
    if (!compose.provider) return { ok: false, reason: 'compose-not-found', guidance: compose.guidance };
    const args = [...compose.prefixArgs, '--project-name', 'jobkits-' + ctx.kit.id, 'logs', '--tail', String(tail), ...(follow ? ['-f'] : [])];
    if (follow) {
      const child = spawn(compose.bin, args, { cwd: ctx.srcDir, env: { ...process.env, ...(ctx.envValues || {}) }, windowsHide: true });
      const emit = (stream) => (buf) => { if (onLine) for (const line of buf.toString('utf8').split(/\r?\n/)) if (line) onLine({ stream, line }); };
      child.stdout.on('data', emit('stdout'));
      child.stderr.on('data', emit('stderr'));
      return { ok: true, child };
    }
    return runCompose(ctx, ['logs', '--tail', String(tail)], { onLine });
  })();
}

/* ================= Podman machine config (v0.2 wizard + settings) =================
 * VirtualBox-style GUI over `podman machine init/set/inspect`. The pure
 * helpers (validateMachineConfig / buildInitArgs / buildSetArgs /
 * normalizeMachineInspect) do no spawning and are unit-tested. Everything
 * that spawns keeps this file's never-throw contract.
 *
 * Inspect field shapes vary across Podman versions (4.x vs 5.x, WSL vs QEMU
 * vs Hyper-V providers): values may live at the top level or under
 * `Resources`, and Memory/DiskSize may be numbers or unit strings
 * ("2048", "2048MB", "2GB", "100GB"). normalizeMachineInspect handles both
 * defensively and yields null for anything it cannot determine.
 */

function hostInfo() {
  return {
    cpus: os.cpus().length,
    totalMemMiB: Math.floor(os.totalmem() / (1024 * 1024)),
    freeDiskHint: null, // Node has no reliable cross-platform free-disk API
  };
}

/* Pure validation. host defaults to this machine; tests pass a fake host.
 * Returns { ok:true, cfg:<normalized> } or { ok:false, reason:'invalid-config', errors:[...] }. */
function validateMachineConfig(cfg = {}, host = hostInfo()) {
  const errors = [];
  const out = {
    name: typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : null,
    rootful: cfg.rootful === true,
    timezone: typeof cfg.timezone === 'string' && cfg.timezone.trim() ? cfg.timezone.trim() : 'local',
    now: cfg.now === true,
  };
  const hostCpus = host && Number.isFinite(host.cpus) && host.cpus > 0 ? host.cpus : Infinity;
  const hostMemMiB = host && Number.isFinite(host.totalMemMiB) && host.totalMemMiB > 0 ? host.totalMemMiB : Infinity;

  if (cfg.name != null && out.name && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(out.name)) {
    errors.push(`Machine name "${out.name}" is not valid — use letters, numbers, dots, dashes or underscores.`);
  }
  out.cpus = Number(cfg.cpus);
  if (!Number.isInteger(out.cpus) || out.cpus < 1) errors.push('CPUs must be at least 1.');
  else if (out.cpus > hostCpus) errors.push(`CPUs cannot be more than this PC has (${hostCpus}).`);
  out.memoryMiB = Number(cfg.memoryMiB);
  if (!Number.isFinite(out.memoryMiB) || out.memoryMiB < 1024) errors.push('Memory must be at least 1024 MiB (1 GiB).');
  else if (out.memoryMiB > hostMemMiB) errors.push(`Memory cannot be more than this PC has (${Math.floor(hostMemMiB / 1024)} GiB).`);
  out.diskSizeGiB = Number(cfg.diskSizeGiB);
  if (!Number.isFinite(out.diskSizeGiB) || out.diskSizeGiB < 10) errors.push('Disk size must be at least 10 GiB.');

  if (errors.length) return { ok: false, reason: 'invalid-config', errors };
  out.cpus = Math.floor(out.cpus);
  out.memoryMiB = Math.floor(out.memoryMiB);
  out.diskSizeGiB = Math.floor(out.diskSizeGiB);
  return { ok: true, cfg: out };
}

/* Pure: validated cfg -> argv for `podman machine init`. */
function buildInitArgs(cfg = {}, host = hostInfo()) {
  const v = validateMachineConfig(cfg, host);
  if (!v.ok) return v;
  const c = v.cfg;
  const args = ['machine', 'init',
    '--cpus', String(c.cpus),
    '--memory', String(c.memoryMiB),
    '--disk-size', String(c.diskSizeGiB)];
  // Rootless is the default; only pass the flag for rootful (both forms are
  // accepted by podman, omitting is the safest spelling for the default).
  if (c.rootful) args.push('--rootful');
  args.push('--timezone', c.timezone);
  if (c.now) args.push('--now');
  if (c.name) args.push(c.name);
  return { ok: true, args };
}

/* Parse a Memory/DiskSize value that may be a number or a unit string.
 * kind 'memory' -> MiB, kind 'disk' -> GiB. Unit-less numbers are assumed to
 * already be in the target unit (inspect reports Memory in MiB, DiskSize in
 * GiB). Units are read as binary (KB treated as KiB, etc.) — that matches how
 * podman sizes machines; a decimal-formatted string from some version would
 * be off by a few percent, which only affects the settings display. */
function parseSize(value, kind) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const m = String(value).trim().match(/^([\d.]+)\s*([KMGT]i?B?|B)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || '').toUpperCase();
  if (unit === '') return Math.round(n);
  const toMiB = { B: n / (1024 * 1024), K: n / 1024, KB: n / 1024, KI: n / 1024, KIB: n / 1024, M: n, MB: n, MI: n, MIB: n, G: n * 1024, GB: n * 1024, GI: n * 1024, GIB: n * 1024, T: n * 1024 * 1024, TB: n * 1024 * 1024, TI: n * 1024 * 1024, TIB: n * 1024 * 1024 };
  if (!(unit in toMiB)) return null;
  const mib = toMiB[unit];
  return kind === 'disk' ? Math.round(mib / 1024) : Math.round(mib);
}

function firstDefined(...vals) { for (const v of vals) if (v !== undefined && v !== null) return v; return null; }

/* Pure: one raw `podman machine inspect` entry (or a `machine list` entry as
 * fallback) -> normalized shape. */
function normalizeMachineInspect(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const res = (raw.Resources && typeof raw.Resources === 'object') ? raw.Resources : {};
  const cpusRaw = firstDefined(raw.CPUs, raw.Cpus, raw.cpus, res.CPUs, res.Cpus, res.cpus);
  const cpus = cpusRaw != null && Number.isFinite(Number(cpusRaw)) ? Number(cpusRaw) : null;
  const memoryMiB = parseSize(firstDefined(raw.Memory, raw.memory, res.Memory, res.memory), 'memory');
  const diskSizeGiB = parseSize(firstDefined(raw.DiskSize, raw.diskSize, res.DiskSize, res.DiskImgSize, res.diskSize), 'disk');
  const rootfulRaw = firstDefined(raw.Rootful, raw.rootful, res.Rootful, res.rootful);
  const rootful = typeof rootfulRaw === 'boolean' ? rootfulRaw : null;
  let state = null; let running = null;
  if (typeof raw.Running === 'boolean') { running = raw.Running; state = running ? 'running' : 'stopped'; }
  if (typeof raw.State === 'string' && raw.State) { state = raw.State.toLowerCase(); running = state === 'running'; }
  if (typeof raw.state === 'string' && raw.state) { state = raw.state.toLowerCase(); running = state === 'running'; }
  const lastUpRaw = firstDefined(raw.LastUp, raw.lastUp);
  const lastUp = typeof lastUpRaw === 'string' && lastUpRaw && !lastUpRaw.startsWith('0001-01-01') ? lastUpRaw : null;
  return {
    ok: true,
    exists: true,
    partial,
    name: raw.Name || raw.name || null,
    cpus, memoryMiB, diskSizeGiB, rootful,
    state, running, lastUp,
  };
}

async function machineListRaw(bin) {
  const ml = await exec(bin, ['machine', 'list', '--format', 'json']);
  if (!ml.ok) return null;
  try { const arr = JSON.parse(ml.stdout || '[]'); return Array.isArray(arr) ? arr : null; } catch { return null; }
}

function pickFromList(machines, name) {
  if (!machines || !machines.length) return null;
  if (name) return machines.find(m => (m.Name || m.name) === name) || null;
  return machines.find(m => m.Running) || machines.find(m => m.Default) || machines[0];
}

/* Normalized info about a machine. Falls back to `machine list` (marked
 * partial:true) when inspect is unavailable or its JSON is unusable. */
async function machineInspect(name, opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const args = ['machine', 'inspect', '--format', 'json'];
  if (name) args.push(name);
  const r = await exec(bin, args, opts);
  if (r.ok) {
    try {
      const parsed = JSON.parse(r.stdout || 'null');
      const entry = Array.isArray(parsed) ? (name ? parsed.find(e => (e.Name || e.name) === name) || parsed[0] : parsed[0]) : parsed;
      const norm = normalizeMachineInspect(entry);
      if (norm) return norm;
    } catch { /* fall through to list fallback */ }
  }
  const machines = await machineListRaw(bin);
  const entry = pickFromList(machines, name);
  if (entry) return normalizeMachineInspect(entry, { partial: true });
  if (machines) {
    return { ok: false, reason: 'machine-missing', exists: false,
      guidance: 'No Podman machine exists yet. Use the "Set up Podman machine" wizard in jobkits to create one — no terminal needed.' };
  }
  return { ok: false, reason: 'machine-inspect-failed', stderr: r.stderr || '', guidance: '`podman machine inspect` failed and the machine list could not be read.' };
}

/* Streamed spawn for long machine operations; lines -> onLine({stream, line}). */
function runStreamed(bin, args, { onLine, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    const killTimer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    const emit = (stream) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        if (onLine) for (const line of lines) if (line) onLine({ stream, line });
      };
    };
    const outDone = emit('stdout'); const errDone = emit('stderr');
    child.stdout.on('data', outDone);
    child.stderr.on('data', errDone);
    child.on('error', (err) => { clearTimeout(killTimer); resolve({ ok: false, reason: 'spawn-failed', error: String(err) }); });
    child.on('close', (code) => { clearTimeout(killTimer); resolve({ ok: code === 0, code }); });
  });
}

/* Create a machine from wizard config. Streams output; the VM image download
 * can take a long time, hence the >= 15 minute timeout. */
async function machineInit(cfg = {}, onLine, opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const host = opts.host || hostInfo();
  const built = buildInitArgs(cfg, host);
  if (!built.ok) return built;
  const r = await runStreamed(bin, built.args, { onLine, timeout: opts.timeout || 15 * 60 * 1000 });
  if (!r.ok) {
    return { ...r, ok: false, reason: r.reason || 'machine-init-failed',
      guidance: r.guidance || '`podman machine init` failed — the streamed output above shows where. Check disk space and network, then try again.' };
  }
  return { ok: true, args: built.args };
}

/* Pure: desired cfg + current normalized inspect -> argv for `podman machine
 * set`, containing ONLY the flags that differ. Disk shrink is an error
 * (podman can only grow a machine disk). */
function buildSetArgs(cfg = {}, current = {}) {
  if (!current || typeof current !== 'object' || !current.exists) {
    return { ok: false, reason: 'machine-missing', errors: ['No existing machine to change — create one with the setup wizard first.'] };
  }
  const errors = [];
  const flags = [];
  const name = cfg.name || current.name || null;

  if (cfg.cpus != null) {
    const cpus = Number(cfg.cpus);
    if (!Number.isInteger(cpus) || cpus < 1) errors.push('CPUs must be at least 1.');
    else if (current.cpus == null || cpus !== current.cpus) flags.push('--cpus', String(cpus));
  }
  if (cfg.memoryMiB != null) {
    const mem = Number(cfg.memoryMiB);
    if (!Number.isFinite(mem) || mem < 1024) errors.push('Memory must be at least 1024 MiB (1 GiB).');
    else if (current.memoryMiB == null || mem !== current.memoryMiB) flags.push('--memory', String(Math.floor(mem)));
  }
  if (cfg.diskSizeGiB != null) {
    const disk = Number(cfg.diskSizeGiB);
    if (!Number.isFinite(disk) || disk < 10) errors.push('Disk size must be at least 10 GiB.');
    else if (current.diskSizeGiB == null || disk !== current.diskSizeGiB) {
      if (current.diskSizeGiB != null && disk < current.diskSizeGiB) {
        errors.push(`Disk can only grow — it is currently ${current.diskSizeGiB} GiB, so ${disk} GiB is not allowed. Pick ${current.diskSizeGiB} GiB or more.`);
      } else flags.push('--disk-size', String(Math.floor(disk)));
    }
  }
  if (cfg.rootful != null) {
    const rootful = cfg.rootful === true;
    if (current.rootful == null || rootful !== current.rootful) flags.push('--rootful=' + rootful);
  }
  if (errors.length) return { ok: false, reason: 'invalid-config', errors };
  if (!flags.length) return { ok: true, args: null, noOp: true, changed: false };
  const args = ['machine', 'set', ...flags];
  if (name) args.push(name);
  return { ok: true, args, noOp: false, changed: true };
}

/* Apply settings to an existing machine. The machine MUST be stopped
 * (podman requirement) — the GUI drives stop -> set -> optional start. */
async function machineSet(cfg = {}, onLine, opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const current = await machineInspect(cfg.name || undefined, opts);
  if (!current.ok) return current;
  if (current.running) {
    return { ok: false, reason: 'machine-running',
      guidance: 'The Podman machine is running — settings can only change while it is stopped. Stop the machine first (jobkits can do this from the settings panel), then apply.' };
  }
  const built = buildSetArgs(cfg, current);
  if (!built.ok) return built;
  if (built.noOp) return { ok: true, noOp: true, current };
  const r = await runStreamed(bin, built.args, { onLine, timeout: opts.timeout || 120000 });
  if (!r.ok) {
    return { ...r, ok: false, reason: r.reason || 'machine-set-failed',
      guidance: r.guidance || '`podman machine set` failed — the streamed output above shows why. Note: on Windows the machine provider (WSL/QEMU) may restrict which settings can change.' };
  }
  return { ok: true, args: built.args, current };
}

/* Start the machine (GUI restart after settings apply, Start flows use
 * ensureMachine). Already-running is success. */
async function machineStart(name, opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return { ok: true, skipped: true };
  const cur = await machineInspect(name, opts);
  if (cur.ok && cur.running) return { ok: true, alreadyRunning: true };
  if (cur.reason === 'machine-missing') return cur;
  const args = ['machine', 'start'];
  if (name) args.push(name);
  const r = await exec(bin, args, { timeout: 180000 });
  return r.ok ? { ok: true, started: true } : { ok: false, reason: 'machine-start-failed', stderr: r.stderr, guidance: '`podman machine start` failed — see the error output.' };
}

/* Stop the machine (settings GUI: stop -> apply). Already-stopped is success. */
async function machineStop(name, opts = {}) {
  const bin = findPodman(opts);
  if (!bin) return { ...NOT_FOUND };
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return { ok: true, skipped: true };
  const cur = await machineInspect(name, opts);
  if (cur.ok && cur.running === false) return { ok: true, alreadyStopped: true };
  if (cur.reason === 'machine-missing') return cur;
  const args = ['machine', 'stop'];
  if (name) args.push(name);
  const r = await exec(bin, args, { timeout: 120000 });
  return r.ok ? { ok: true, stopped: true } : { ok: false, reason: 'machine-stop-failed', stderr: r.stderr, guidance: '`podman machine stop` failed — see the error output.' };
}

module.exports = {
  INSTALL_URL, NOT_FOUND, candidatePaths, findOnPath, findPodman,
  getStatus, ensureMachine, detectCompose, composeUp, composeDown, composePs, composeLogs,
  hostInfo, validateMachineConfig, buildInitArgs, buildSetArgs, normalizeMachineInspect,
  machineInspect, machineInit, machineSet, machineStart, machineStop,
  _resetComposeCache: () => { composeCache = null; },
};
