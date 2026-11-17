import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createLocalProjects} from './projects-local.mjs';
import {createProjectRunner} from './projects-runner.mjs';

test('real CLI workers run in parallel, read Library, wait through restart, obey allow/deny and cancel',
  {skip:!process.env.PROJECTS_TEST_CLI,timeout:180000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'project-cli-'));let backend;
  const requests=[],readMarkers=new Set();
  const server=http.createServer(async(req,res)=>{
    if(!req.url.startsWith('/v1/messages'))return void backend.handle(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));});
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
    const words=body.messages.map(m=>typeof m.content==='string'?m.content:m.content.map(c=>c.type==='text'?c.text:JSON.stringify(c)).join('\n')).join('\n');
    const marker=words.includes('DENY_TOOL')?'DENY_TOOL':words.includes('CANCEL_TOOL')?'CANCEL_TOOL':'ALLOW_TOOL';
    const results=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='tool_result'):[]);
    if(JSON.stringify(results).includes('OWNED_LIBRARY_REFERENCE'))readMarkers.add(marker);
    let content;
    if(results.length===0) {
      const library=/Project Library snapshot: ([^\n\\]+)/.exec(words)?.[1];
      content=[{type:'tool_use',id:'toolu_read_'+marker,name:'Read',input:{file_path:path.join(library||directory,'notes.txt')}}];
    }else if(results.length===1)content=[{type:'tool_use',id:'toolu_bash_'+marker,name:'Bash',input:{command:`printf '${marker}' > ${marker}.txt`,description:'Write an owned local Projects fixture'}}];
    else content=[{type:'text',text:'FINISHED_'+marker}];
    const message={id:'msg_owned_'+requests.length,type:'message',role:'assistant',model:body.model,content,stop_reason:content[0].type==='text'?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(message));}
    const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}}];
    content.forEach((c,index)=>events.push({type:'content_block_start',index,content_block:c.type==='text'?{type:'text',text:''}:{...c,input:{}}},
      {type:'content_block_delta',index,delta:c.type==='text'?{type:'text_delta',text:c.text}:{type:'input_json_delta',partial_json:JSON.stringify(c.input)}},{type:'content_block_stop',index}));
    events.push({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'});
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  const open=()=>createLocalProjects({directory,accountId:'fixture',models:()=>({model:'fixture/claude-sonnet-5-5'}),clientKey:'owned-key',
    runner:createProjectRunner({directory:path.join(directory,'execution'),binary:process.env.PROJECTS_TEST_CLI,baseUrl:origin,clientKey:'owned-key',profileHome:directory})});
  backend=open();const request=async(route,method='GET',value)=>{
    const r=await fetch(origin+route,{method,headers:{authorization:'Bearer owned-key','content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
    const body=await r.json();assert.ok(r.ok,JSON.stringify(body));return body;
  };
  async function until(fn,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await delay(200);}throw Error('Real project worker timed out: '+JSON.stringify(backend.snapshot().jobs.map(({tool_token,...j})=>j)));}
  let base;
  try{
    const channel=(await request('/v1/code/channels','POST',{name:'CLI fixture',settings:{coordinator_mode_enabled:false}})).channel;base='/v1/code/channels/'+channel.id;
    await request(base+'/files:write','POST',{files:[{path:'notes.txt',content:Buffer.from('OWNED_LIBRARY_REFERENCE').toString('base64')}]});
    const allow=(await request(base+'/threads','POST',{title:'Allow',prompt:'ALLOW_TOOL'})).thread;
    const deny=(await request(base+'/threads','POST',{title:'Deny',prompt:'DENY_TOOL'})).thread;
    await until(()=>backend.snapshot().permissions.filter(p=>p.state==='pending'&&p.tool_name==='Bash').length===2);
    const before=backend.snapshot();assert.equal(before.jobs.filter(j=>j.state==='running').length,2);
    const workspace=id=>path.join(directory,'execution',channel.id,'workspaces',id);
    assert.equal(fs.existsSync(path.join(workspace(allow.id),'ALLOW_TOOL.txt')),false);
    assert.equal(fs.existsSync(path.join(workspace(deny.id),'DENY_TOOL.txt')),false);
    backend.close();backend=open();await delay(500);
    assert.equal(backend.snapshot().jobs.length,2,'core recovery did not start duplicate CLI jobs');
    for(const p of backend.snapshot().permissions.filter(p=>p.state==='pending'))await request(base+'/permissions/'+p.id,'POST',{decision:p.thread_id===allow.id?'allow':'deny'});
    await until(()=>backend.snapshot().jobs.every(j=>j.state==='completed'));
    assert.equal(fs.readFileSync(path.join(workspace(allow.id),'ALLOW_TOOL.txt'),'utf8'),'ALLOW_TOOL');
    assert.equal(fs.existsSync(path.join(workspace(deny.id),'DENY_TOOL.txt')),false);
    assert.deepEqual([...readMarkers].sort(),['ALLOW_TOOL','DENY_TOOL']);
    const cancel=(await request(base+'/threads','POST',{title:'Cancel',prompt:'CANCEL_TOOL'})).thread;
    await until(()=>backend.snapshot().permissions.some(p=>p.thread_id===cancel.id&&p.state==='pending'));
    await request(base+'/threads/'+cancel.id+'/cancel','POST',{});
    await until(()=>backend.snapshot().jobs.find(j=>j.thread_root_id===cancel.id).state==='cancelled');
    assert.equal(fs.existsSync(path.join(workspace(cancel.id),'CANCEL_TOOL.txt')),false);
  }finally{
    if(process.env.PROJECTS_TEST_EVIDENCE){fs.mkdirSync(process.env.PROJECTS_TEST_EVIDENCE,{recursive:true});
      fs.writeFileSync(path.join(process.env.PROJECTS_TEST_EVIDENCE,'integration.json'),JSON.stringify({jobs:backend.snapshot().jobs.map(({tool_token,directory,...j})=>j),requestCount:requests.length,readMarkers:[...readMarkers]},null,2));
      for(const job of backend.snapshot().jobs)if(job.directory)for(const name of ['status.json','stdout.log','stderr.log']){
        const source=path.join(job.directory,name);if(fs.existsSync(source))fs.copyFileSync(source,path.join(process.env.PROJECTS_TEST_EVIDENCE,job.id+'-'+name));
      }
    }
    for(const t of backend.snapshot().threads)if(['queued','running'].includes(t.state)&&base)try{await request(base+'/threads/'+t.id+'/cancel','POST',{});}catch{}
    await delay(500);backend.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});
  }
});
