import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createLocalProjects} from './projects-local.mjs';

test('local project state survives a service restart without access to official Projects',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'projects-local-'));
  let backend=createLocalProjects({directory,accountId:'fixture-account',models:()=>({model:'fixture/model'}),clientKey:'fixture-local-key'});
  const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');backend.handle(req,res,url).catch(()=>{res.writeHead(400);res.end('{}');});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,method='GET',body,extra={})=>{
    const res=await fetch(url+route,{method,headers:{authorization:'Bearer fixture-local-key',
      ...(body?{'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
    return{status:res.status,body:await res.json()};
  };
  try {
    const made=await request('/v1/code/channels','POST',{name:'Owned local project',system_prompt_addendum:'Owned fixture only'});
    assert.equal(made.status,201);const id=made.body.channel.id;
    assert.match(id,/^chan_/);assert.equal(made.body.channel.execution_backend,'claudemom-local');
    const files=`/v1/code/channels/${id}`;
    const write=await request(files+'/files:write','POST',{files:[{path:'reference/notes.md',content:Buffer.from('Owned project knowledge').toString('base64'),overwrite:false}]});
    assert.equal(write.status,200);assert.ok(write.body.results[0].content_sha256);
    assert.equal((await request(files+'/files:write','POST',{files:[{path:'../outside',content:'',overwrite:true}]})).status,400);
    const memoryBase=`/v1/code/memory/channel/${id}/memories`;
    const memory=await request(memoryBase,'POST',{path:'decisions.md',content:'Original decision',precondition:{type:'not_exists'}});
    assert.equal(memory.status,201);
    const update=await request(memoryBase+'/'+memory.body.id,'POST',{content:'New decision',precondition:{type:'content_sha256',content_sha256:memory.body.content_sha256}});
    assert.equal(update.status,200);
    assert.equal((await request(memoryBase+'/'+memory.body.id,'POST',{content:'Lost update',precondition:{type:'content_sha256',content_sha256:memory.body.content_sha256}})).status,409);
    backend.close();backend=createLocalProjects({directory,accountId:'fixture-account',models:()=>({model:'fixture/model'}),clientKey:'fixture-local-key'});
    assert.equal((await request('/v1/code/channels')).body.data[0].id,id);
    assert.equal((await request(`/v1/code/channels/${id}`)).body.channel.system_prompt_addendum,'Owned fixture only');
    assert.equal((await request(files+'/files:list','POST',{path:'/',recursive:true})).body.entries[0].path,'reference/notes.md');
    assert.equal((await request(memoryBase+'/'+memory.body.id)).body.content,'New decision');
    await request(files+'/files:mkdir','POST',{path:'empty-folder'});
    assert.ok((await request(files+'/files:list','POST',{path:'/',recursive:true})).body.entries.some(e=>e.path==='empty-folder'&&e.is_directory));
    const binary=Buffer.alloc(2*1024*1024,0xa5);
    assert.equal((await request(files+'/files:write','POST',{files:[{path:'binary.bin',content:binary.toString('base64')}]})).status,200);
    assert.equal((await request(files+'/files:move','POST',{source_path:'reference',destination_path:'renamed'})).status,200);
    const opened=await request(files+'/files:open','POST',{path:'binary.bin'});
    assert.deepEqual(Buffer.from(opened.body.content,'base64'),binary);
    assert.equal((await request(files+'/files:delete','POST',{path:'renamed'})).status,409);
    assert.equal((await request(files+'/files:delete','POST',{path:'renamed',recursive:true})).status,200);
    assert.equal((await request(`/v1/code/channels/${id}/messages`,'POST',{body:'Do not pretend a worker exists'})).status,503);
    assert.equal((await request('/v1/code/channels','POST',{name:'Cross-origin'}, {origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/v1/code/channels','POST',{name:'No token'},{authorization:'Bearer wrong'})).status,403);
    assert.equal((await request('/v1/code/channels','POST',{name:'Wrong content type'},{'content-type':'text/plain'})).status,415);
  } finally {backend.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
});
