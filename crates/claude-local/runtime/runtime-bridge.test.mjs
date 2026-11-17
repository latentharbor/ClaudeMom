import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./runtime-bridge.js', import.meta.url), 'utf8');
const settle = async () => { for (let i=0;i<40;i++) await new Promise(resolve=>setImmediate(resolve)); };
function harness({ outcome = { outcome: 'restarted' }, draft = false, running = false, routeOnly = false,
  frozen = false, getAll } = {}) {
  const posts = [], storage = new Map(), calls = [];
  let hide, reloads = 0;
  const loaded = 'a'.repeat(64), target = routeOnly ? loaded : 'b'.repeat(64);
  const sessions = [{ sessionId: 'local_abc', cliSessionId: 'abc', model: 'fixture/model', isRunning: running }];
  const api = { getAll: getAll || (async()=>sessions), sendMessage: async()=>{},
    applyModelByRestart: async(...args)=>{ calls.push(args); return outcome; } };
  const cowork = { getAll: async()=>[], sendMessage: async()=>{} };
  if (frozen) { Object.freeze(api); Object.freeze(cowork); }
  const window = { 'claude.web': { LocalSessions: api, LocalAgentModeSessions: cowork },
    fetch: async (_url, options) => {
      if (options?.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ schema:1, token:'fixture', revision:target,
        pendingCoreRevision: routeOnly ? null : target, retiredSessions:routeOnly?['abc']:[],
        activeWork:0, activeDictation:0 }), { headers:{'content-type':'application/json'} });
    } };
  window.top = window;
  vm.runInNewContext(source, { window, location:{origin:'https://claude.ai',reload(){reloads++;}},
    document:{querySelector:()=>({content:loaded}),querySelectorAll:()=>draft?[{value:'draft'}]:[]},
    sessionStorage:{setItem:(key,value)=>storage.set(key,value)},
    setInterval:()=>1,clearInterval(){},setTimeout,AbortSignal,
    addEventListener(name, fn){if(name==='pagehide')hide=fn;} });
  return { posts,calls,storage,window,hide:()=>hide(),get reloads(){return reloads;} };
}

test('actual Desktop outcome envelope permits idle SDK and frontend refresh, including a frozen bridge', async()=>{
  for (const frozen of [false,true]) {
    const h=harness({frozen});await settle();
    assert.equal(h.reloads,1);
    assert.equal(h.storage.get('claudeMom.lastNativeRefresh'),'restarted');
    assert.ok(h.posts.some(p=>p.preparedRevision==='b'.repeat(64)&&p.confirmedIdle.includes('abc')));
  }
});
test('busy or unknown native replies invalidate approval instead of forcing a reload',async()=>{
  for(const outcome of [{outcome:'busy'},{unexpected:'restarted'}]) {
    const h=harness({outcome});await settle();
    assert.equal(h.reloads,0);assert.ok(h.posts.some(p=>p.toolsReady===false));
    assert.ok(h.posts.every(p=>!p.preparedRevision));
  }
});
test('a running task and an unsent draft defer all surface changes',async()=>{
  for(const options of [{running:true},{draft:true}]) {
    const h=harness(options);await settle();assert.equal(h.reloads,0);assert.equal(h.calls.length,0);
  }
});
test('an ended routing generation can retire without reloading or losing an unsent next prompt',async()=>{
  const h=harness({routeOnly:true,draft:true});await settle();
  assert.equal(h.reloads,0);assert.equal(h.calls.length,1);
  assert.ok(h.posts.some(p=>p.draft===true&&p.confirmedIdle?.includes('abc')));
});
test('a departing renderer cannot publish late idle evidence or restart a native session',async()=>{
  let release;
  const h=harness({getAll:()=>new Promise(resolve=>{release=resolve;})});await settle();
  h.hide();release([]);await settle();
  assert.equal(h.calls.length,0);assert.equal(h.posts.length,0);assert.equal(h.reloads,0);
});
