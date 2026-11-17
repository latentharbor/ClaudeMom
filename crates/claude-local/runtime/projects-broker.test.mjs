import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createProjectBroker} from './projects-broker.mjs';

test('job broker pins inference and credentials and refuses other jobs and Desktop routes',async()=>{
  const received=[],jobId='11111111-1111-4111-8111-111111111111',toolToken='job-token-for-fixture';
  const parent=http.createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;
    received.push({path:req.url,headers:req.headers,body:raw?JSON.parse(raw):null});res.setHeader('content-type','application/json');res.end('{"ok":true}');});
  parent.listen(0,'127.0.0.1');await once(parent,'listening');
  const broker=await createProjectBroker({upstream:`http://127.0.0.1:${parent.address().port}`,clientKey:'PRIVATE_GLOBAL_KEY',toolToken,jobId,model:'owned/model',smallModel:'owned/claude-haiku-5-5',models:['owned/model','owned/claude-haiku-5-5'],sessionId:'fixed-session'});
  const request=(route,method='GET',body,headers={})=>fetch(broker.origin+route,{method,headers:{authorization:`Bearer ${toolToken}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    assert.equal((await request('/v1/messages','POST',{model:'wrong',messages:[]})).status,200);
    assert.equal(received[0].body.model,'owned/model');assert.equal(received[0].headers.authorization,'Bearer PRIVATE_GLOBAL_KEY');assert.equal(received[0].headers['x-claude-code-session-id'],'fixed-session');
    assert.equal((await request(`/__codex_plus/projects-lab/jobs/${jobId}/tools`,'POST',{name:'list_project_files'})).status,200);
    assert.equal(received[1].headers.authorization,`Bearer ${toolToken}`);
    const system=[{type:'text',text:'OFFICIAL_CLI_SYSTEM',cache_control:{type:'ephemeral',ttl:'1h'}}];
    assert.equal((await request('/v1/messages?beta=true','POST',{model:'claude-haiku-5-5',system,messages:[]},{'x-stainless-os':'MacOS','x-claude-code-session-id':'spoof'})).status,200);
    assert.equal(received[2].body.model,'owned/claude-haiku-5-5');assert.deepEqual(received[2].body.system,system);
    assert.equal(received[2].headers['x-stainless-os'],'MacOS');assert.equal(received[2].headers['x-claude-code-session-id'],'fixed-session');
    assert.deepEqual((await(await request('/v1/models')).json()).data.map(m=>m.id),['owned/model']);
    for(const route of ['/v1/code/channels','/__codex_claude_local/health','/__codex_plus/projects-lab/diagnostics',
      '/__codex_plus/projects-lab/jobs/22222222-2222-4222-8222-222222222222/tools','/api/bootstrap','/v1/messages?target=elsewhere']){
      assert.equal((await request(route,'POST',{})).status,403,route);
    }
    assert.equal((await request('/v1/messages','POST',{}, {authorization:'Bearer wrong'})).status,403);
    assert.equal((await request('/v1/messages','POST',{}, {origin:'https://claude.ai'})).status,403);
    assert.equal(received.length,3,'forbidden routes never reach the privileged parent');
    await assert.rejects(()=>createProjectBroker({upstream:'http://192.0.2.1',clientKey:'x',toolToken,jobId}));
  }finally{await broker.close();parent.closeAllConnections();await new Promise(r=>parent.close(r));}
});
