import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {createLocalProjects} from './projects-local.mjs';
import {nextOccurrence} from './projects-schedule.mjs';

async function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'project-engine-')),hosts=new Map();
  let at=Date.parse('2026-11-17T00:59:59Z'),backend;
  const fakeRunner=()=>({active:()=>[...hosts.values()].filter(h=>!h.result).length,close(){},
    run(options){const dir=path.join(directory,'execution',options.projectId,'jobs',options.jobId);options.onPrepared?.({directory:dir});
      let resolve;const done=new Promise(r=>{resolve=r;});
      const host={options,directory:dir,callbacks:[],done,complete(result){this.result=result;resolve(result);for(const cb of this.callbacks)cb(result);}};
      hosts.set(options.jobId,host);return{directory:dir,done};},
    observe(dir,callback){const host=[...hosts.values()].find(h=>h.directory===dir);if(host.result)queueMicrotask(()=>callback(host.result));else host.callbacks.push(callback);},
    cancel(dir){const host=[...hosts.values()].find(h=>h.directory===dir);queueMicrotask(()=>host.complete({state:'cancelled',result:''}));}});
  const open=()=>createLocalProjects({directory,accountId:'owned',models:()=>({model:'fixture/model'}),clientKey:'owned-key',runner:fakeRunner(),clock:()=>at,scheduleInterval:0});
  backend=open();
  const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const request=async(route,method='GET',value,token='owned-key')=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}`+route,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});return{status:r.status,body:await r.json()};
  };
  t.after(async()=>{backend.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
  const channel=(await request('/v1/code/channels','POST',{name:'Owned',settings:{coordinator_mode_enabled:false}})).body.channel;
  return{request,channel,hosts,get backend(){return backend;},restart(){backend.close();backend=open();},setTime(value){at=Date.parse(value);}};
}
async function until(fn){for(let n=0;n<100;n++){const value=fn();if(value)return value;await setImmediate();}throw Error('Project engine did not reach the expected state');}

test('parallel lanes, durable approval, deny and queued follow-up survive a core restart',async t=>{
  const f=await fixture(t),base='/v1/code/channels/'+f.channel.id;
  const first=(await f.request(base+'/threads','POST',{title:'One',prompt:'One task'})).body.thread;
  const second=(await f.request(base+'/threads','POST',{title:'Two',prompt:'Two task'})).body.thread;
  await until(()=>f.hosts.size===2);
  const jobs=f.backend.snapshot().jobs;assert.equal(jobs.filter(j=>j.state==='running').length,2);
  assert.notEqual(jobs[0].session_id,jobs[1].session_id);
  assert.notEqual([...f.hosts.values()][0].options.lane,[...f.hosts.values()][1].options.lane);
  assert.equal([...f.hosts.values()][1].options.prompt.includes('One task'),false,'a new worker does not inherit another worker\'s task history');
  await f.request(base+'/messages','POST',{body:'Queued continuation',in_reply_to_message_id:first.id});
  assert.equal(f.backend.snapshot().jobs.filter(j=>j.state==='queued').length,1);
  const job=jobs.find(j=>j.thread_root_id===first.id),tool=`/__codex_plus/projects-lab/jobs/${job.id}/tools`;
  const permission=await f.request(tool,'POST',{name:'approve',request_id:'permission-1',input:{tool_name:'Bash',input:{command:'owned operation'}}},job.tool_token);
  assert.equal(permission.status,200);
  assert.deepEqual((await f.request(tool,'POST',{name:'approve',request_id:'permission-1',input:{tool_name:'Bash',input:{command:'owned operation'}}},job.tool_token)).body,permission.body);
  const exposed=(await f.request(base+'/local')).body;assert.equal(JSON.stringify(exposed).includes(job.tool_token),false);
  f.restart();await setImmediate();assert.equal(f.hosts.size,2,'recovery observes existing hosts rather than launching them again');
  assert.equal((await f.request(base+'/permissions/'+permission.body.id,'POST',{decision:'deny'})).status,200);
  assert.equal((await f.request(tool+'/'+permission.body.id,'GET',undefined,job.tool_token)).body.state,'denied');
  assert.equal((await f.request(base+'/permissions/'+permission.body.id,'POST',{decision:'allow'})).status,409);
  f.hosts.get(job.id).complete({state:'completed',result:'First result'});
  await until(()=>f.hosts.size===3);
  assert.equal([...f.hosts.values()].at(-1).options.resume,true);
  assert.equal([...f.hosts.values()].at(-1).options.prompt.includes('Recent conversation:'),false);
  const other=jobs.find(j=>j.thread_root_id===second.id);f.hosts.get(other.id).complete({state:'completed',result:'Second result'});
  const cancelled=await f.request(base+'/threads/'+first.id+'/cancel','POST',{});assert.equal(cancelled.status,200);
  await until(()=>f.backend.snapshot().jobs.every(j=>!['queued','running'].includes(j.state)));
});

test('one-time and zoned cron schedules coalesce missed occurrences and retain pause state',async t=>{
  const f=await fixture(t),base='/v1/code/channels/'+f.channel.id;
  const once=(await f.request(base+'/schedules','POST',{name:'Once',prompt:'Once',run_once_at:'2026-11-17T01:00:00Z',timezone:'Australia/Perth'})).body.trigger;
  const daily=(await f.request(base+'/schedules','POST',{name:'Daily',prompt:'Daily',cron_expression:'0 9 * * *',timezone:'Australia/Perth'})).body.trigger;
  assert.equal(daily.next_run_at,'2026-11-17T01:00:00.000Z');
  f.setTime('2026-11-17T01:00:01Z');f.backend.tick();f.backend.tick();await setImmediate();
  assert.equal(f.backend.snapshot().threads.length,2);
  assert.equal(f.backend.snapshot().schedules.find(s=>s.id===once.id).enabled,false);
  f.restart();await setImmediate();f.backend.tick();assert.equal(f.backend.snapshot().threads.length,2);
  f.setTime('2026-11-20T03:00:00Z');f.backend.tick();await setImmediate();assert.equal(f.backend.snapshot().threads.length,3,'three missed days create one catch-up run');
  await f.request('/v1/code/triggers/'+daily.id,'PATCH',{enabled:false});f.restart();await setImmediate();
  f.setTime('2026-11-22T03:00:00Z');f.backend.tick();assert.equal(f.backend.snapshot().threads.length,3);
});

test('cron uses local wall clock through DST and rejects invalid expressions',()=>{
  assert.equal(nextOccurrence({cron_expression:'30 2 * * *',timezone:'America/New_York'},Date.parse('2026-03-08T06:59:00Z')),'2026-03-09T06:30:00.000Z');
  assert.throws(()=>nextOccurrence({cron_expression:'80 2 * * *',timezone:'UTC'},Date.now()));
});
