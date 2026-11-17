// Stable loopback listener. The GUI may exit; this process and its current core
// remain alive. Only one core ever writes the conversation store at a time.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const descriptor = process.env.CLAUDE_LOCAL_SERVICE_CONFIG;
if (!descriptor || path.dirname(descriptor) !== root) throw Error('Private service configuration required');
const ready = path.join(root, 'ready.json');
const stopFile = path.join(root, 'service-stop.json');
const instanceId = process.env.CLAUDE_LOCAL_INSTANCE_ID;
const requestedPort = Number(process.env.CLAUDE_LOCAL_SERVICE_PORT || 0);
// OS ownership outlives the GUI and is released only after the core exits.
// A separate owner cannot start another writer during startup/adoption races.
const ownershipPort = 20000 + crypto.createHash('sha256').update(fs.realpathSync(root)).digest().readUInt16BE(0) % 20000;
const ownership = net.createServer(socket => socket.destroy());
let current, wanted, worker, workerPort, workerHealth = {}, lastReport = 0, safe = false;
let activeRequests = 0, switching = true, stopping = false, lastError = null;
let approvedCoreRevision = null;
let approvedAt = 0;
const crashes = [];
const tunnels = new Set(), waiters = new Set();
let attempted = '';

function privateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 ||
      process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw Error('Private service file required');
  return JSON.parse(fs.readFileSync(file));
}
function candidate() {
  const value = privateJson(descriptor);
  const realRoot = fs.realpathSync(root);
  if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.revision) ||
      !/^[a-f0-9]{64}$/.test(value.coreRevision) || typeof value.env !== 'object' || !value.env ||
      Object.entries(value.env).some(([key, val]) => !/^(CLAUDE_LOCAL_[A-Z][A-Z0-9_]*|CODEX_PLUS_STATE_DIR)$/.test(key) ||
        typeof val !== 'string' || val.length > 1024 * 1024) ||
      typeof value.worker !== 'string' || !value.worker.startsWith(path.join(root, 'releases') + path.sep) ||
      !/^[a-f0-9]{64}$/.test(path.basename(path.dirname(value.worker))) || path.basename(value.worker) !== 'proxy.mjs' ||
      fs.realpathSync(value.worker) !== path.join(realRoot, 'releases', path.basename(path.dirname(value.worker)), 'proxy.mjs')) throw Error('Invalid service configuration');
  return value;
}
function health() {
  return { ...workerHealth, schema: 1, serviceProtocol: 1, pid: process.pid,
    workerPid: worker?.pid, port: server.address()?.port, ownershipPort, mode: 'mock', instanceId,
    configHash: current?.revision, pendingConfigHash: wanted?.revision !== current?.revision ? wanted?.revision : null,
    coreRevision: current?.coreRevision, pendingCoreRevision: wanted?.coreRevision !== current?.coreRevision ? wanted?.coreRevision : null,
    bridgeFresh: Date.now() - lastReport < 5000, activeRequests,
    idleApprovedRevision: approvedCoreRevision, nativeIdle: safe,
    ...(lastError ? { warning: lastError } : {}) };
}
function receipt() {
  if (!server.listening || !workerPort) return;
  const temporary = `${ready}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(health()), { mode: 0o600 });
  fs.renameSync(temporary, ready);
}
async function available() {
  if (workerPort && !switching) return workerPort;
  if (waiters.size >= 64) throw Error('Service transition queue is full');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(done); reject(Error('Service transition timed out')); }, 15000);
    const done = () => { clearTimeout(timer); resolve(workerPort); };
    waiters.add(done);
  });
}
async function boot(next) {
  switching = true;
  safe = false;
  approvedCoreRevision = null;
  workerHealth = {};
  lastReport = 0;
  // Keep versioned code immutable; no new manager overwrites a running core.
  const child = spawn(process.execPath, [next.worker, '--port', '0', '--mode', 'mock', '--log', '0', '--ca', path.join(root, 'ca')], {
    env: { ...process.env, ...next.env, CLAUDE_LOCAL_CORE_WORKER: '1',
      CLAUDE_LOCAL_READY_FILE: path.join(root, 'core-ready.json'), CLAUDE_LOCAL_CONFIG_REVISION: next.revision,
      CLAUDE_LOCAL_INSTANCE_ID: instanceId, CLAUDE_LOCAL_PUBLIC_PROXY_PORT: String(server.address().port) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  worker = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Core startup timed out')); }, 12000);
    child.on('message', message => {
      if (child !== worker) return;
      if (message?.type === 'health') {
        workerHealth = message.health;
        if (!workerPort && child === worker) {
          workerPort = message.health.port;
          current = next;
          switching = false;
          clearTimeout(timeout);
          resolve();
          for (const done of waiters) done();
          waiters.clear();
        }
        receipt();
      }
      if (message?.type === 'tasks') {
        lastReport = Date.now();
        safe = message.idle === true && message.active === 0 && message.draft === false && message.toolsReady === true;
        if (!safe) { approvedCoreRevision = null; approvedAt = 0; }
        else if (/^[a-f0-9]{64}$/.test(message.preparedRevision || '')) {
          approvedCoreRevision = message.preparedRevision;
          approvedAt = Date.now();
        }
      }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => {
      clearTimeout(timeout);
      if (worker !== child) return;
      workerPort = null;
      if (!stopping && !switching) {
        lastError = 'Compatibility core exited. Review the local service log before retrying.';
        switching = true;
        crashes.push(Date.now());
        while (crashes[0] < Date.now() - 60000) crashes.shift();
        if (crashes.length <= 3) setTimeout(async () => {
          if (stopping || worker !== child) return;
          try { await boot(current); }
          catch { lastError = 'Compatibility core could not recover; current requests were not replayed.'; }
        }, 500);
      }
      reject(Error('Core exited'));
    });
  });
}
async function reconcile() {
  if (stopping) return;
  try {
    const stop = fs.existsSync(stopFile) && privateJson(stopFile);
    if (stop?.instanceId === instanceId) return shutdown();
    wanted = candidate();
    if (wanted.revision === current?.revision || attempted === wanted.revision) return;
    if (switching) return;
    if (wanted.coreRevision === current?.coreRevision) {
      worker.send({ type: 'configure', env: wanted.env, revision: wanted.revision });
      return; // current is acknowledged by the core, never merely by a file write
    }
    // Missing/stale renderer evidence blocks replacement, including tool gaps.
    worker.send({ type: 'updatePending', revision: wanted.coreRevision });
    if (!safe || Date.now() - lastReport >= 5000 || activeRequests !== 0 || workerHealth.activeInference !== 0 ||
        workerHealth.activeDictation !== 0 || approvedCoreRevision !== wanted.coreRevision || Date.now() - approvedAt > 5000) return;
    switching = true;
    const prepared = await new Promise(resolve => {
      const timeout = setTimeout(() => { worker.off('message', observe); resolve(false); }, 3000);
      const observe = message => {
        if (message?.type !== 'prepared') return;
        clearTimeout(timeout); worker.off('message', observe); resolve(message.idle === true);
      };
      worker.on('message', observe);
      worker.send({ type: 'prepareUpdate' });
    });
    if (!prepared) { switching = false; return; }
    attempted = wanted.revision;
    // Kill only idle connections after the last complete native idle snapshot.
    for (const socket of tunnels) socket.destroy();
    const old = worker;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Idle core did not stop')), 5000);
      old.once('exit', () => { clearTimeout(timeout); resolve(); }); old.send({ type: 'shutdown' });
    });
    worker = null; workerPort = null;
    const previous = current;
    try { await boot(wanted); }
    catch {
      worker = null; workerPort = null;
      await boot(previous);
      lastError = 'The new core failed to start; the previous compatible core was restored.';
      return;
    }
    lastError = null;
  } catch {
    lastError = 'A pending service update could not be applied; the current configuration was retained.';
  } finally { receipt(); }
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__codex_claude_local/health' && req.headers.origin === undefined) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(health()));
  }
  activeRequests++;
  let complete = false;
  const finish = () => { if (!complete) { complete = true; activeRequests--; } };
  res.once('close', finish); res.once('finish', finish);
  try {
    const port = await available();
    if (req.destroyed) return;
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers,
      agent: false }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => up.destroy());
    req.pipe(up);
  } catch { res.writeHead(503); res.end('Local service update pending'); }
});
function tunnel(req, socket, head) {
  tunnels.add(socket); socket.once('close', () => tunnels.delete(socket));
  socket.on('error', () => {}); socket.pause();
  available().then(port => {
    if (socket.destroyed) return;
    const up = net.connect(port, '127.0.0.1', () => {
      let header = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) header += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(header + '\r\n'); if (head.length) up.write(head);
      socket.pipe(up); up.pipe(socket); socket.resume();
    });
    up.on('error', () => socket.destroy());
    socket.once('close', () => up.destroy());
    up.once('close', () => socket.destroy());
  }).catch(() => socket.destroy());
}
server.on('connect', tunnel); server.on('upgrade', tunnel);
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (server.listening) server.close();
  for (const socket of tunnels) socket.destroy();
  const finish = () => {
    if (ownership.listening) ownership.close(() => process.exit(process.exitCode || 0));
    else process.exit(process.exitCode || 0);
  };
  if (worker && worker.exitCode === null) {
    worker.once('exit', finish);
    if (worker.connected) worker.send({ type: 'shutdown' });
    else worker.kill('SIGTERM');
    setTimeout(() => worker?.kill('SIGKILL'), 2000).unref();
  } else finish();
}
function listen() { server.listen(requestedPort, '127.0.0.1', async () => {
  try { wanted = candidate(); await boot(wanted); receipt(); }
  catch (error) { console.error('Local service startup failed:', error.stack); shutdown(); process.exitCode = 1; }
}); }
let reconciling = false;
const timer = setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    if (workerHealth.configHash && current && workerHealth.configHash === wanted?.revision) {
      current = wanted;
      lastError = null;
    }
    await reconcile();
  } finally { reconciling = false; }
}, 500);
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
ownership.once('error', () => {
  console.error('Independent service ownership is already held; refusing a second state writer.');
  process.exitCode = 1;
  shutdown();
});
ownership.listen(ownershipPort, '127.0.0.1', listen);
// stdin intentionally has no lifecycle role. GUI updates must not stop tasks.
