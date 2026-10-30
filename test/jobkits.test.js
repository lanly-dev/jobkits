'use strict';
/* node test/jobkits.test.js — kits loader, env generation, podman-missing.
 * Runs on a machine WITHOUT podman (this VM): podman absence is a tested
 * state, not an environment failure.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const kits = require('../lib/kits');
const envfile = require('../lib/envfile');
const health = require('../lib/health');
const podmanLib = require('../lib/podman');

(async () => {
  // ---- kits: the bundled freehire kit loads and validates
  const all = kits.listKits();
  assert.strictEqual(all.length, 1);
  const fh = all[0];
  assert.strictEqual(fh.id, 'freehire');
  assert.strictEqual(fh.pinnedCommit, 'def9d6882fc78c1d15b5a4c9f11d502d3c3bb19c');
  assert.strictEqual(fh.webPortEnv, 'WEB_HOST_PORT');
  assert.strictEqual(fh.defaultPorts[fh.webPortEnv], fh.webPort);
  assert.strictEqual(fh.defaultPorts[fh.healthPortEnv], fh.healthPort);
  assert.ok(fh.requiredSecrets.includes('JWT_SECRET'));
  assert.ok(fs.existsSync(fh.composePath));
  const compose = fs.readFileSync(fh.composePath, 'utf8');
  for (const svc of ['app', 'db', 'meilisearch', 'redis', 's3', 's3-init', 'web']) {
    assert.ok(new RegExp('^  ' + svc + ':', 'm').test(compose), 'compose missing service ' + svc);
  }
  assert.ok(compose.includes('pgvector/pgvector:pg18'), 'db image pin lost');
  assert.ok(compose.includes('def9d6882fc78c1d15b5a4c9f11d502d3c3bb19c'), 'compose header pin missing');
  console.log('kits load: ok');

  // ---- kits: invalid manifests are rejected
  assert.ok(kits.validateManifest({ id: 'x' }, 'x').length >= 5);
  const bad = { ...fh, id: 'other' };
  assert.ok(kits.validateManifest(bad, 'freehire').some(e => e.includes('must match folder')));
  assert.deepStrictEqual(kits.validateManifest(fh, 'freehire'), []);
  console.log('kits validation: ok');

  // ---- env: generation, secret strength, stability across runs
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobkits-test-'));
  const statePath = path.join(tmp, 'jobkits-state.json');
  const srcDir = path.join(tmp, 'src');
  const r1 = await envfile.ensureKitEnv({ kit: fh, srcDir, statePath, settings: {} });
  assert.ok(r1.created, 'first run should report created');
  assert.ok(fs.existsSync(r1.envPath));
  assert.ok(r1.values.JWT_SECRET.length >= 48, 'JWT_SECRET must be >=48 chars');
  assert.ok(r1.values.MEILI_MASTER_KEY.length >= 48);
  assert.ok(r1.values.POSTGRES_PASSWORD.length >= 48);
  assert.strictEqual(Number(r1.values[fh.webPortEnv]), fh.webPort, 'free default web port should be kept');
  const envText1 = fs.readFileSync(r1.envPath, 'utf8');
  assert.ok(envText1.includes('JWT_SECRET=' + r1.values.JWT_SECRET));
  const r2 = await envfile.ensureKitEnv({ kit: fh, srcDir, statePath, settings: {} });
  assert.strictEqual(r2.values.JWT_SECRET, r1.values.JWT_SECRET, 'secrets must never regenerate');
  assert.strictEqual(r2.values[fh.webPortEnv], r1.values[fh.webPortEnv], 'ports must stay stable');
  assert.ok(!r2.created, 'second run creates nothing new');
  const persisted = envfile.loadState(statePath);
  assert.strictEqual(persisted.kits.freehire.secrets.JWT_SECRET, r1.values.JWT_SECRET);
  console.log('env generation + stability: ok');

  // ---- env: LLM settings passthrough (empty default)
  const r3 = await envfile.ensureKitEnv({ kit: fh, srcDir, statePath, settings: { LLM_MODEL: 'test-model', LLM_BASE_URL: 'http://localhost:11434/v1' } });
  assert.strictEqual(r3.values.LLM_MODEL, 'test-model');
  assert.strictEqual(r3.values.LLM_API_KEY, '');
  const r4 = await envfile.ensureKitEnv({ kit: fh, srcDir, statePath, settings: {} });
  assert.strictEqual(r4.values.LLM_MODEL, '');
  console.log('env LLM passthrough: ok');

  // ---- env: occupied default port is skipped
  const blocker = net.createServer();
  await new Promise(res => blocker.listen(fh.defaultPorts[fh.webPortEnv], '127.0.0.1', res));
  try {
    const state2 = path.join(tmp, 'state2.json');
    const r5 = await envfile.ensureKitEnv({ kit: fh, srcDir: path.join(tmp, 'src2'), statePath: state2, settings: {} });
    const chosen = Number(r5.values[fh.webPortEnv]);
    assert.notStrictEqual(chosen, fh.webPort, 'occupied default must not be chosen');
    assert.ok(await envfile.isPortFree(chosen), 'chosen port must actually be free');
    assert.strictEqual(r5.values.WEB_ORIGIN, 'http://localhost:' + chosen, 'origins must follow chosen web port');
    console.log('env port probe (default occupied -> ' + chosen + '): ok');
  } finally {
    await new Promise(res => blocker.close(res));
  }

  // ---- podman: missing binary degrades gracefully (PATH emptied)
  const savedPath = process.env.PATH;
  const savedJobkitsPodman = process.env.JOBKITS_PODMAN;
  process.env.PATH = '';
  delete process.env.JOBKITS_PODMAN;
  try {
    // re-require with a clean module so PATH lookups really re-run; on this
    // Linux VM /usr/bin/podman does not exist, so candidate paths miss too.
    delete require.cache[require.resolve('../lib/podman')];
    const podman = require('../lib/podman');
    if (podman.findPodman()) {
      console.log('podman-missing: skipped (a podman binary exists at a fallback path on this machine)');
    } else {
      const st = await podman.getStatus();
      assert.strictEqual(st.found, false);
      assert.strictEqual(st.reason, 'podman-not-found');
      assert.ok(st.guidance.includes('podman.io'));
      const ctx = { kit: fh, srcDir, envValues: {} };
      assert.strictEqual((await podman.composeUp(ctx)).reason, 'podman-not-found');
      assert.strictEqual((await podman.composeDown(ctx)).reason, 'podman-not-found');
      const ps = await podman.composePs(ctx);
      assert.strictEqual(ps.reason, 'podman-not-found');
      assert.deepStrictEqual(ps.services, []);
      const logs = await podman.composeLogs(ctx);
      assert.strictEqual(logs.reason, 'podman-not-found');
      assert.strictEqual((await podman.ensureMachine()).reason, 'podman-not-found');
      // v0.2 machine functions degrade the same way, never throw
      assert.strictEqual((await podman.machineInspect()).reason, 'podman-not-found');
      assert.strictEqual((await podman.machineInit({ cpus: 2, memoryMiB: 4096, diskSizeGiB: 30 })).reason, 'podman-not-found');
      assert.strictEqual((await podman.machineSet({ cpus: 2 })).reason, 'podman-not-found');
      assert.strictEqual((await podman.machineStop()).reason, 'podman-not-found');
      assert.strictEqual((await podman.machineStart()).reason, 'podman-not-found');
      console.log('podman-missing graceful path: ok');
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedJobkitsPodman !== undefined) process.env.JOBKITS_PODMAN = savedJobkitsPodman;
  }

  // ---- machine config (v0.2): hostInfo + pure validation
  const hi = podmanLib.hostInfo();
  assert.strictEqual(hi.cpus, os.cpus().length);
  assert.ok(hi.totalMemMiB > 0);
  assert.strictEqual(hi.freeDiskHint, null);
  const HOST = { cpus: 8, totalMemMiB: 32768 };
  const good = { cpus: 4, memoryMiB: 8192, diskSizeGiB: 50, rootful: false, now: true };
  assert.strictEqual(podmanLib.validateMachineConfig(good, HOST).ok, true);
  for (const badCfg of [
    { ...good, cpus: 0 }, { ...good, cpus: 9 }, { ...good, cpus: 2.5 },
    { ...good, memoryMiB: 512 }, { ...good, memoryMiB: 65536 },
    { ...good, diskSizeGiB: 5 }, { ...good, name: 'bad name!' },
  ]) {
    const v = podmanLib.validateMachineConfig(badCfg, HOST);
    assert.strictEqual(v.ok, false, 'should reject ' + JSON.stringify(badCfg));
    assert.strictEqual(v.reason, 'invalid-config');
    assert.ok(v.errors.length >= 1);
  }
  console.log('machine validateMachineConfig: ok');

  // ---- machine config: buildInitArgs exact argv
  const initSample = { name: 'jk-test', cpus: 4, memoryMiB: 8192, diskSizeGiB: 50, rootful: true, now: true };
  const initRes = podmanLib.buildInitArgs(initSample, HOST);
  assert.strictEqual(initRes.ok, true);
  assert.deepStrictEqual(initRes.args, ['machine', 'init', '--cpus', '4', '--memory', '8192', '--disk-size', '50', '--rootful', '--timezone', 'local', '--now', 'jk-test']);
  const initRootless = podmanLib.buildInitArgs({ ...initSample, rootful: false, now: false, name: undefined }, HOST);
  assert.ok(!initRootless.args.includes('--rootful'), 'rootless must not pass --rootful');
  assert.ok(!initRootless.args.includes('--now'));
  assert.strictEqual(initRootless.args[initRootless.args.indexOf('--timezone') + 1], 'local', 'timezone defaults to local');
  assert.deepStrictEqual(podmanLib.buildInitArgs({ ...good, cpus: 99 }, HOST).reason, 'invalid-config');
  console.log('machine buildInitArgs: ok');

  // ---- machine config: buildSetArgs diffs only, disk grow-only
  const current = { exists: true, name: 'podman-machine-default', cpus: 4, memoryMiB: 8192, diskSizeGiB: 50, rootful: false };
  const noChange = podmanLib.buildSetArgs({ cpus: 4, memoryMiB: 8192, diskSizeGiB: 50, rootful: false }, current);
  assert.strictEqual(noChange.ok, true);
  assert.strictEqual(noChange.noOp, true);
  assert.strictEqual(noChange.args, null);
  const ramOnly = podmanLib.buildSetArgs({ memoryMiB: 16384 }, current);
  assert.deepStrictEqual(ramOnly.args, ['machine', 'set', '--memory', '16384', 'podman-machine-default']);
  const shrink = podmanLib.buildSetArgs({ diskSizeGiB: 30 }, current);
  assert.strictEqual(shrink.ok, false);
  assert.strictEqual(shrink.reason, 'invalid-config');
  assert.ok(shrink.errors.join(' ').includes('only grow'));
  const grow = podmanLib.buildSetArgs({ diskSizeGiB: 100 }, current);
  assert.deepStrictEqual(grow.args.slice(0, 4), ['machine', 'set', '--disk-size', '100']);
  const flip = podmanLib.buildSetArgs({ rootful: false }, { ...current, rootful: true });
  assert.ok(flip.args.includes('--rootful=false'), 'rootful flip off must be explicit');
  const flipOn = podmanLib.buildSetArgs({ rootful: true }, current);
  assert.ok(flipOn.args.includes('--rootful=true'));
  assert.strictEqual(podmanLib.buildSetArgs({ cpus: 2 }, { exists: false }).reason, 'machine-missing');
  console.log('machine buildSetArgs: ok');

  // ---- machine inspect normalization (both field shapes)
  const n1 = podmanLib.normalizeMachineInspect({ Name: 'm1', Rootful: true, State: 'running', LastUp: '2026-10-29T00:00:00Z', Resources: { CPUs: 4, Memory: 8192, DiskSize: 50 } });
  assert.deepStrictEqual([n1.name, n1.cpus, n1.memoryMiB, n1.diskSizeGiB, n1.rootful, n1.running], ['m1', 4, 8192, 50, true, true]);
  const n2 = podmanLib.normalizeMachineInspect({ Name: 'm2', CPUs: 2, Memory: '4096MB', DiskSize: '100GB', Running: false });
  assert.deepStrictEqual([n2.cpus, n2.memoryMiB, n2.diskSizeGiB, n2.running, n2.state], [2, 4096, 100, false, 'stopped']);
  const n3 = podmanLib.normalizeMachineInspect({ Name: 'm3' });
  assert.deepStrictEqual([n3.cpus, n3.memoryMiB, n3.diskSizeGiB, n3.rootful], [null, null, null, null]);
  console.log('machine normalizeMachineInspect: ok');

  // ---- health: instant failure against a closed port, success vs stub
  const closed = await health.waitForHealth({ port: 1, healthPath: '/health', timeoutMs: 300, intervalMs: 50 });
  assert.strictEqual(closed.ok, false);
  assert.strictEqual(closed.reason, 'timeout');
  const http = require('node:http');
  const stub = http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}'); });
  await new Promise(res => stub.listen(0, '127.0.0.1', res));
  try {
    const okRes = await health.waitForHealth({ port: stub.address().port, healthPath: '/health', timeoutMs: 3000, intervalMs: 25 });
    assert.strictEqual(okRes.ok, true);
    console.log('health polling: ok');
  } finally { stub.close(); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
