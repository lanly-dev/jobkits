'use strict';
/* Upstream source checkout for a kit.
 * The kit compose file builds services from the upstream source tree, so on
 * first run jobkits clones kit.repo into <userData>/kits/<id>/src and checks
 * out kit.pinnedCommit. Later runs reuse the checkout; a drifted HEAD is
 * reset back to the pin. Requires git on PATH; degrades to {ok:false}
 * guidance rather than throwing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function runGit(args, { cwd, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stderr = '';
    const emit = (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      if (onLine) for (const line of text.split(/\r?\n/)) if (line) onLine({ stream: 'git', line });
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => resolve({ ok: false, code: -1, stderr: String(err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));
  });
}

async function headCommit(srcDir) {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd: srcDir });
  return r.ok ? r.stderr.trim().split(/\r?\n/).pop() : null;
}

async function ensureSource(kit, srcDir, { onLine } = {}) {
  const gitDir = path.join(srcDir, '.git');
  if (!fs.existsSync(gitDir)) {
    if (fs.existsSync(srcDir) && fs.readdirSync(srcDir).filter(f => f !== '.env').length > 0) {
      return { ok: false, reason: 'src-dir-blocked', guidance: `${srcDir} exists and is not a git checkout of ${kit.repo}. Move it aside and press Start again.` };
    }
    fs.mkdirSync(path.dirname(srcDir), { recursive: true });
    const clone = await runGit(['clone', '--no-checkout', kit.repo, srcDir], { onLine });
    if (!clone.ok) {
      return { ok: false, reason: 'clone-failed', guidance: `git clone of ${kit.repo} failed (is git installed and the network reachable?).`, stderr: clone.stderr.slice(-500) };
    }
  }
  const head = await headCommit(srcDir);
  if (head === kit.pinnedCommit) return { ok: true, already: true, srcDir };
  const fetch = await runGit(['fetch', '--depth', '1', 'origin', kit.pinnedCommit], { cwd: srcDir, onLine });
  if (!fetch.ok) {
    const fetchAll = await runGit(['fetch', 'origin'], { cwd: srcDir, onLine });
    if (!fetchAll.ok) return { ok: false, reason: 'fetch-failed', guidance: 'git fetch failed — check the network and try again.', stderr: fetchAll.stderr.slice(-500) };
  }
  const co = await runGit(['checkout', '--detach', kit.pinnedCommit], { cwd: srcDir, onLine });
  if (!co.ok) return { ok: false, reason: 'checkout-failed', guidance: `Could not check out pinned commit ${kit.pinnedCommit}.`, stderr: co.stderr.slice(-500) };
  return { ok: true, checkedOut: kit.pinnedCommit, srcDir };
}

module.exports = { ensureSource, headCommit, runGit };
