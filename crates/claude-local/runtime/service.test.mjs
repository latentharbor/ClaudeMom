import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = letter => letter.repeat(64);
async function until(fn) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error('Service fixture timed out');
}

test('stable listener survives its GUI pipe; idle barrier, queued handoff and rollback preserve one writer', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudemom-service-')));
  fs.copyFileSync(path.join(here, 'service.mjs'), path.join(root, 'service.mjs'));
  // A small core double isolates listener/ownership behavior from the native UI.
  // Real HTTP/TLS routing and native lifecycle have separate integration checks.
  const source = `import http from 'node:http';import fs from 'node:fs';
    const file=process.env.CODEX_PLUS_STATE_DIR+'/writer';
    const lock=fs.openSync(file,'wx');
    let active=0,pendingRevision,busy=false;
    const health=()=>process.send({type:'health',health:{port:server.address().port,activeInference:active,activeDictation:0,configHash:process.env.CLAUDE_LOCAL_CONFIG_REVISION}});
    const server=http.createServer((req,res)=>{
      if(req.url==='/busy'||req.url==='/idle'){
        busy=req.url==='/busy';
        process.send({type:'tasks',idle:!busy,active:busy?1:0,draft:false,toolsReady:true,preparedRevision:pendingRevision});
      }
      res.end(process.env.CLAUDE_LOCAL_GATEWAY_MODEL);
    }).listen(0,'127.0.0.1',health);
    process.on('message',m=>{
      if(m.type==='updatePending'){pendingRevision=m.revision;if(!busy)process.send({type:'tasks',idle:true,active:0,draft:false,toolsReady:true,preparedRevision:pendingRevision});}
      if(m.type==='configure'){process.env.CLAUDE_LOCAL_GATEWAY_MODEL=m.env.CLAUDE_LOCAL_GATEWAY_MODEL;process.env.CLAUDE_LOCAL_CONFIG_REVISION=m.revision;health();}
      if(m.type==='prepareUpdate')process.send({type:'prepared',idle:true});
      if(m.type==='shutdown'){fs.closeSync(lock);fs.unlinkSync(file);server.close(()=>process.exit(0));}
    });
    process.on('SIGTERM',()=>{try{fs.closeSync(lock);fs.unlinkSync(file);}catch{}process.exit(0);});`;
  function descriptor(letter, core, model, bad = false) {
    const dir = path.join(root, 'releases', hash(core)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'proxy.mjs'), bad ? 'syntax invalid here !' : source);
    const candidate = { schema: 1, revision: hash(letter), coreRevision: hash(core), worker: path.join(dir, 'proxy.mjs'),
      env: { CODEX_PLUS_STATE_DIR: root, CLAUDE_LOCAL_WEB_I18N_DIR: root,
        CLAUDE_LOCAL_GATEWAY_MODEL: model, CLAUDE_LOCAL_CONFIG_REVISION: hash(letter) } };
    fs.writeFileSync(path.join(root, 'next.json'), JSON.stringify(candidate), { mode: 0o600 });
    fs.renameSync(path.join(root, 'next.json'), path.join(root, 'service-config.json'));
  }
  descriptor('a', 'a', 'first');
  const child = spawn(process.execPath, [path.join(root, 'service.mjs')], {
    env: { ...process.env, CLAUDE_LOCAL_SERVICE_CONFIG: path.join(root, 'service-config.json'), CLAUDE_LOCAL_INSTANCE_ID: 'fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', x => { output += x; }); child.stdout.resume();
  const closed = once(child, 'exit');
  try {
    const ready = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(root, 'ready.json'))); } catch { return null; }
    });
    const url = `http://127.0.0.1:${ready.port}`;
    const get = route => fetch(url + route).then(r => r.text());
    const health = () => fetch(url + '/__codex_claude_local/health').then(r => r.json());
    child.stdin.end(); // manager update/exit must not affect the service
    assert.equal(await get('/busy'), 'first');
    const original = await health();
    descriptor('b', 'a', 'second');
    await until(async () => (await health()).configHash === hash('b'));
    assert.equal(await get('/model'), 'second');
    assert.equal((await health()).workerPid, original.workerPid);
    descriptor('c', 'c', 'third');
    await delay(1200);
    assert.equal((await health()).workerPid, original.workerPid, 'HTTP-free native tool phase remains busy');
    assert.equal((await health()).pendingConfigHash, hash('c'));
    await get('/idle');
    await until(async () => (await health()).configHash === hash('c'));
    assert.equal(await get('/model'), 'third');
    assert.equal((await health()).pid, original.pid);
    assert.notEqual((await health()).workerPid, original.workerPid);
    descriptor('d', 'd', 'bad', true);
    await get('/idle');
    await until(async () => (await health()).warning?.includes('restored'));
    assert.equal(await get('/model'), 'third', 'failed core restored without concurrent state writers');
    fs.writeFileSync(path.join(root, 'service-config.json'), '{}', { mode: 0o600 });
    await delay(700);
    assert.equal(await get('/model'), 'third', 'malformed candidate leaves the current core intact');
  } catch (error) { throw Error(`${error.message}\n${output}`); }
  finally {
    fs.writeFileSync(path.join(root, 'service-stop.json'), JSON.stringify({ instanceId: 'fixture' }), { mode: 0o600 });
    await closed;
    await until(() => !fs.existsSync(path.join(root, 'writer')));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
