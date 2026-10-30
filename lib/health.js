'use strict';
/* Health polling: GET http://127.0.0.1:<port><healthPath> until 200.
 * First builds can take minutes (freehire compiles a Go binary + a SvelteKit
 * frontend and pulls 5 images), so the default cap is ~5 minutes with a
 * steady 2s interval. Resolves (never rejects): {ok:true} on 200,
 * {ok:false, reason:'timeout'} when the cap is hit.
 */
const http = require('node:http');

function probeOnce(port, healthPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: healthPath, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForHealth({ port, healthPath = '/health', timeoutMs = 5 * 60 * 1000, intervalMs = 2000, onProgress } = {}) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    if (await probeOnce(port, healthPath)) {
      return { ok: true, attempts: attempt, elapsedMs: Date.now() - started };
    }
    const elapsedMs = Date.now() - started;
    if (onProgress) onProgress({ attempt, elapsedMs, port, healthPath });
    if (elapsedMs >= timeoutMs) return { ok: false, reason: 'timeout', attempts: attempt, elapsedMs };
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = { probeOnce, waitForHealth };
