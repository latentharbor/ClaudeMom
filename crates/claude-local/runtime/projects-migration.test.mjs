import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLocalProjects} from './projects-local.mjs';

test('legacy experiment migration keeps IDs, messages, Library and memory without touching Desktop session roots',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'projects-migration-')),
    channel='chan_11111111111141118111111111111111',root='cmsg_22222222222242228222222222222222',reply='cmsg_33333333333343338333333333333333';
  const source={schema:1,channels:[{id:channel,name:'Legacy fixture',topic:'Preserve this',created_at:'2026-11-17T00:00:00Z',settings:{coordinator_mode_enabled:false}}],
    threads:[{id:root,channel_id:channel,title:'Legacy thread',created_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:01:00Z'}],
    messages:[{id:root,channel_id:channel,thread_root_id:root,body:'Original task',author_account_id:'fixture',created_at:'2026-11-17T00:00:00Z'},
      {id:reply,channel_id:channel,thread_root_id:root,body:'Original result',author_session_id:'old-session',created_at:'2026-11-17T00:01:00Z'}],
    files:[{channel_id:channel,path:'legacy.txt',content:Buffer.from('Original bytes').toString('base64')}],
    memories:[{channel_id:channel,path:'decision.md',content:'Original decision'}],jobs:[],permissions:[],schedules:[]};
  const file=path.join(directory,'projects.json');fs.writeFileSync(file,JSON.stringify(source));const original=fs.readFileSync(file);
  const options={directory,accountId:'fixture',models:()=>({model:'fixture/model'}),clientKey:'fixture-key',scheduleInterval:0};let backend;
  try{
    backend=createLocalProjects(options);const migrated=backend.snapshot();
    assert.deepEqual(fs.readFileSync(file+'.pre-ds-project'),original);
    assert.equal(migrated.channels[0].id,channel);assert.equal(migrated.threads[0].id,root);
    assert.equal(migrated.messages.filter(m=>m.id===root).length,1);assert.equal(migrated.messages.find(m=>m.id===reply).body,'Original result');
    assert.equal(Buffer.from(migrated.files.find(f=>f.path==='legacy.txt').content,'base64').toString(),'Original bytes');
    assert.equal(migrated.memories.find(m=>m.path==='/decision.md').content,'Original decision');
    assert.ok(backend.core.engine.store.path.startsWith(directory+path.sep));
    backend.close();backend=createLocalProjects(options);
    assert.equal(backend.snapshot().channels.length,1);assert.equal(backend.snapshot().threads.length,1);
    assert.deepEqual(fs.readFileSync(file+'.pre-ds-project'),original);
  }finally{backend?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
