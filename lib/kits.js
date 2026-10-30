'use strict';
/* Kit loader: scans kits/<id>/kit.json, validates manifests.
 * A kit is a folder. Dropping a new folder with a valid kit.json (and its
 * compose.yml) is the ONLY step needed for the kit to appear in the app.
 *
 * Manifest spec (see README):
 *   id              unique slug, must match the folder name
 *   name            display name
 *   description     one-paragraph description
 *   repo            upstream git repo URL (cloned at pinnedCommit on first run)
 *   pinnedCommit    full 40-char commit sha to check out
 *   composeFile     compose file name inside the kit folder (reference copy;
 *                   the file actually executed is the one in the checked-out
 *                   upstream source tree)
 *   portEnv         map service name -> env var that sets its host port
 *   defaultPorts    map env var -> default host port
 *   webPort         host port (default) serving the kit web UI
 *   webPortEnv      env var that overrides webPort
 *   healthPath      HTTP path polled for readiness (e.g. "/health")
 *   healthPort      host port (default) the health path lives on
 *   healthPortEnv   env var that overrides healthPort
 *   requiredSecrets env var names jobkits generates once and persists
 *   optionalEnv     env var names passed through from user settings
 *   services        service names in the compose file (for status dots)
 */
const fs = require('node:fs');
const path = require('node:path');

const KITS_DIR = path.join(__dirname, '..', 'kits');

function validateManifest(m, dirName) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(m && typeof m === 'object', 'manifest must be an object');
  if (!m || typeof m !== 'object') return errors;
  need(typeof m.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(m.id), 'id: slug string required');
  need(m.id === dirName, `id "${m.id}" must match folder name "${dirName}"`);
  need(typeof m.name === 'string' && m.name.length > 0, 'name: non-empty string required');
  need(typeof m.description === 'string' && m.description.length > 0, 'description: non-empty string required');
  need(typeof m.repo === 'string' && /^https:\/\//.test(m.repo), 'repo: https URL required');
  need(typeof m.pinnedCommit === 'string' && /^[0-9a-f]{40}$/.test(m.pinnedCommit), 'pinnedCommit: full 40-char sha required');
  need(typeof m.composeFile === 'string' && m.composeFile.length > 0, 'composeFile: required');
  need(m.portEnv && typeof m.portEnv === 'object' && Object.keys(m.portEnv).length > 0, 'portEnv: at least one service->env entry required');
  need(m.defaultPorts && typeof m.defaultPorts === 'object', 'defaultPorts: object required');
  if (m.portEnv && m.defaultPorts) {
    for (const [svc, envName] of Object.entries(m.portEnv)) {
      need(typeof envName === 'string' && /^[A-Z][A-Z0-9_]*$/.test(envName), `portEnv.${svc}: env var name expected`);
      need(Number.isInteger(m.defaultPorts[envName]), `defaultPorts.${envName}: integer port required for portEnv.${svc}`);
    }
  }
  need(Number.isInteger(m.webPort) && m.webPort > 0 && m.webPort < 65536, 'webPort: valid port required');
  need(typeof m.webPortEnv === 'string', 'webPortEnv: required');
  need(typeof m.healthPath === 'string' && m.healthPath.startsWith('/'), 'healthPath: must start with /');
  need(Number.isInteger(m.healthPort) && m.healthPort > 0 && m.healthPort < 65536, 'healthPort: valid port required');
  need(typeof m.healthPortEnv === 'string', 'healthPortEnv: required');
  need(Array.isArray(m.requiredSecrets), 'requiredSecrets: array required');
  if (Array.isArray(m.requiredSecrets)) {
    for (const s of m.requiredSecrets) need(/^[A-Z][A-Z0-9_]*$/.test(s), `requiredSecrets: "${s}" is not an env var name`);
  }
  need(Array.isArray(m.services) && m.services.length > 0, 'services: non-empty array required');
  return errors;
}

function loadKit(dir) {
  const manifestPath = path.join(dir, 'kit.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch (e) { throw new Error(`${manifestPath}: invalid JSON (${e.message})`); }
  const errors = validateManifest(manifest, path.basename(dir));
  if (errors.length) throw new Error(`${manifestPath}: ${errors.join('; ')}`);
  const composePath = path.join(dir, manifest.composeFile);
  if (!fs.existsSync(composePath)) throw new Error(`${manifestPath}: composeFile "${manifest.composeFile}" not found next to kit.json`);
  return { ...manifest, dir, manifestPath, composePath };
}

function listKits(kitsDir = KITS_DIR) {
  if (!fs.existsSync(kitsDir)) return [];
  const kits = [];
  for (const name of fs.readdirSync(kitsDir).sort()) {
    const dir = path.join(kitsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'kit.json'))) continue;
    kits.push(loadKit(dir));
  }
  return kits;
}

function getKit(id, kitsDir = KITS_DIR) {
  const kit = listKits(kitsDir).find(k => k.id === id);
  if (!kit) throw new Error('unknown kit: ' + id);
  return kit;
}

// Renderer-safe view: no absolute paths beyond what the UI needs for display.
function publicKit(kit) {
  return {
    id: kit.id, name: kit.name, description: kit.description, repo: kit.repo,
    pinnedCommit: kit.pinnedCommit, webPort: kit.webPort, healthPath: kit.healthPath,
    services: kit.services, defaultPorts: kit.defaultPorts,
  };
}

module.exports = { KITS_DIR, validateManifest, loadKit, listKits, getKit, publicKit };
