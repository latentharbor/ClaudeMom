import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createProjectRunner } from './projects-runner.mjs';

test('owned bundled CLI executes a local project tool with no Desktop process',{skip:!process.env.PROJECTS_TEST_CLI,timeout:120000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'projects-runner-')),requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    if(!req.url.startsWith('/v1/messages')){res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
    const body=JSON.parse(raw);requests.push(body);
    const done=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'));
    const content=done?[{type:'text',text:'LOCAL_PROJECT_TOOL_FINISHED'}]:[{type:'tool_use',id:'toolu_project_write',name:'Bash',input:{command:"printf 'LOCAL_PROJECT_EXECUTION_OK' > PROJECT_EXECUTION_OK.txt",description:'Write the owned Projects fixture'}}];
    const message={id:'msg_project_fixture',type:'message',role:'assistant',model:body.model,content,
      stop_reason:done?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
    if(!body.stream){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(message));}
    const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}}];
    content.forEach((block,index)=>{
      events.push({type:'content_block_start',index,content_block:block.type==='text'?{type:'text',text:''}:{...block,input:{}}});
      events.push({type:'content_block_delta',index,delta:block.type==='text'?{type:'text_delta',text:block.text}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
      events.push({type:'content_block_stop',index});
    });
    events.push({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'});
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let observed=0;
  const options={directory:path.join(root,'jobs'),binary:process.env.PROJECTS_TEST_CLI,baseUrl:`http://127.0.0.1:${server.address().port}`,
    clientKey:'owned-project-fixture-key',profileHome:root,onActiveChange:n=>{observed=Math.max(observed,n);}};
  const first=createProjectRunner(options),projectId='chan_local_execution_fixture';
  const job=first.run({projectId,prompt:'Run the owned project tool and report its result.',model:'fixture/claude-sonnet-5-5'});
  // Detach the observing compatibility core immediately. The independent job
  // host and CLI must still finish; a replacement core can observe its result.
  first.close();const next=createProjectRunner(options);
  try{
    const result=await new Promise(resolve=>next.observe(job.directory,resolve));
    assert.equal(result.state,'completed',JSON.stringify(result));
    assert.match(result.result,/LOCAL_PROJECT_TOOL_FINISHED/);
    assert.equal(fs.readFileSync(path.join(job.workspace,'PROJECT_EXECUTION_OK.txt'),'utf8'),'LOCAL_PROJECT_EXECUTION_OK');
    assert.ok(requests.length>=2);assert.equal(observed,1);
    assert.equal(fs.existsSync(path.join(job.directory,'launch.json')),false);
    assert.ok(requests.every(r=>r.model==='fixture/claude-sonnet-5-5'));
  }finally{next.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
