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
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const INSTALL_URL = 'https://podman.io/docs/installation';

const NOT_FOUND = Object.freeze({
  ok: false,
  reason: 'podman-not-found',
  guidance: `Podman was not found on this machine. Install it from ${INSTALL_URL} — ` +
    'on Windows, then run `podman machine init` and `podman machine start` once in a terminal, and restart jobkits.',
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
            ? 'No Podman machine exists yet. Run `podman machine init` in a terminal, then `podman machine start`.'
            : (!running ? 'Podman machine is stopped. jobkits runs `podman machine start` for you on Start, or run it in a terminal.' : null),
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
    return { ok: false, reason: 'machine-missing', guidance: 'No Podman machine exists yet. Run `podman machine init` in a terminal once (it downloads a Linux VM image), then press Start again.' };
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

module.exports = {
  INSTALL_URL, NOT_FOUND, candidatePaths, findOnPath, findPodman,
  getStatus, ensureMachine, detectCompose, composeUp, composeDown, composePs, composeLogs,
  _resetComposeCache: () => { composeCache = null; },
};
