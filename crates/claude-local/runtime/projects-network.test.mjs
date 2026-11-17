import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createProjectBroker} from './projects-broker.mjs';
import {publicAddress} from './projects-network.mjs';

test('private, loopback, metadata, CGNAT and Fake-IP ranges never qualify as public destinations',()=>{
  for(const ip of ['127.0.0.1','10.1.1.1','172.16.0.2','192.168.100.10','169.254.169.254','100.64.0.1','198.18.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fd00::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['93.184.216.34','8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
});

test('external proxy needs an actual task permission and pins DNS without forwarding its credential',async()=>{
  const token='scoped-network-token',jobId='11111111-1111-4111-8111-111111111111',requests=[],connections=[];let decision='denied',approvals=0;
  const remote=http.createServer((req,res)=>{requests.push(req.headers);res.end('PUBLIC_FIXTURE');});
  const parent=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;
    assert.equal(req.headers.authorization,`Bearer ${token}`);
    if(req.method==='POST'){const data=JSON.parse(raw);assert.equal(data.input.tool_name,'Network');assert.equal(data.input.input.hostname,'public.fixture');approvals++;res.end(JSON.stringify({id:'perm_network'}));}
    else res.end(JSON.stringify({state:decision}));
  });
  remote.listen(0,'127.0.0.1');parent.listen(0,'127.0.0.1');await Promise.all([once(remote,'listening'),once(parent,'listening')]);
  // Only test code injects transport functions. Production uses the real DNS
  // resolver and net.connect; there is no environment/settings bypass.
  const broker=await createProjectBroker({upstream:`http://127.0.0.1:${parent.address().port}`,clientKey:'GLOBAL_KEY_NEVER_EXPOSED',toolToken:token,jobId,model:'owned/model',sessionId:'owned-session',
    networkDependencies:{resolveHost:async host=>host==='private.fixture'?[{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}],
      connect:options=>{connections.push(options);return net.connect({host:'127.0.0.1',port:remote.address().port});}}});
  const address=new URL(broker.origin),headers={'proxy-authorization':'Basic '+Buffer.from('project:'+token).toString('base64')};
  const request=target=>new Promise((resolve,reject)=>{const req=http.request({hostname:address.hostname,port:address.port,path:target,headers},res=>{let body='';res.on('data',p=>body+=p);res.once('end',()=>resolve({status:res.statusCode,body}));});req.once('error',reject);req.end();});
  try{
    assert.equal((await request('http://private.fixture/')).status,403);assert.equal(approvals,0);assert.equal(connections.length,0);
    assert.equal((await request('http://127.0.0.1:3425/v1/models')).status,403);assert.equal(approvals,0);
    assert.equal((await request('http://public.fixture/denied')).status,403);assert.equal(approvals,1);assert.equal(connections.length,0);
    decision='allowed';const allowed=await request('http://public.fixture/approved');assert.equal(allowed.status,200);assert.equal(allowed.body,'PUBLIC_FIXTURE');
    assert.deepEqual(connections,[{host:'93.184.216.34',port:80}]);assert.equal(approvals,2);
    await request('http://public.fixture/again');assert.equal(approvals,2,'a permission lasts only for this task and destination');
    for(const sent of requests){assert.equal(sent['proxy-authorization'],undefined);assert.equal(JSON.stringify(sent).includes(token),false);assert.equal(JSON.stringify(sent).includes('GLOBAL_KEY'),false);}
  }finally{await broker.close();remote.closeAllConnections();parent.closeAllConnections();await Promise.all([new Promise(r=>remote.close(r)),new Promise(r=>parent.close(r))]);}
});
