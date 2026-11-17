// Trusted per-job loopback broker. The sandbox can reach only this listener,
// not the main proxy, other projects, NAS directly, or other local services.
// The global gateway key stays in this host process, outside the sandbox.
import http from 'node:http';
import {once} from 'node:events';
import {constantToken} from './hot-runtime.mjs';
import {createProjectNetwork} from './projects-network.mjs';
import {gatewayModel} from './runtime.mjs';

export async function createProjectBroker({upstream,clientKey,toolToken,jobId,model,smallModel=model,models=[],sessionId,networkDependencies={}}) {
  const parent=new URL(upstream);
  if(parent.protocol!=='http:'||parent.hostname!=='127.0.0.1'||parent.pathname!=='/'||parent.search||parent.hash||parent.username||parent.password)throw Error('A local parent proxy is required');
  if(!clientKey||!toolToken||!/^[a-f0-9-]{36}$/i.test(jobId))throw Error('Invalid task broker credentials');
  const prefix=`/__codex_plus/projects-lab/jobs/${jobId}/tools`;
  const routing={managed:true,model,smallModel,models:[...new Set([model,smallModel,...models])]};
  const sockets=new Set(),requests=new Set();let closed=false;
  const network=createProjectNetwork({parent,toolToken,jobId,...networkDependencies});let origin;
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    try{
      if(/^https?:\/\//.test(req.url)){
        const absolute=new URL(req.url);
        if(absolute.origin===origin)req.url=absolute.pathname+absolute.search;
        else return await network.handle(req,res);
      }
      const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
      if(closed||req.headers.origin!==undefined||!req.url.startsWith('/')||req.url.startsWith('//')||
        !constantToken(String(req.headers['x-api-key']||bearer),toolToken))return json(res,403,{error:{message:'Task authorization required'}});
      const url=new URL(req.url,'http://127.0.0.1');if(url.search&&url.search!=='?beta=true')return json(res,403,{error:{message:'Task route is not allowed'}});
      const inference=req.method==='POST'&&['/v1/messages','/v1/messages/count_tokens'].includes(url.pathname);
      const mcp=!url.search&&((req.method==='POST'&&url.pathname===prefix)||(req.method==='GET'&&new RegExp('^'+prefix+'/perm_[A-Za-z0-9_-]+$').test(url.pathname)));
      if(req.method==='GET'&&url.pathname==='/v1/models')return json(res,200,{data:[{id:model,type:'model',display_name:model}],has_more:false});
      // CLI policy/bootstrap lookups receive fixed empty local data, never an
      // arbitrary authenticated relay into the main Desktop API.
      if(req.method==='GET'&&/^\/api\/claude_(?:cli\/bootstrap|code\/(?:policy_limits|settings|managed_settings))(?:\/|$)/.test(url.pathname))return json(res,200,{settings:{},data:[],enabled:true});
      if(!inference&&!mcp)return json(res,403,{error:{message:'Task route is not allowed'}});
      const parts=[];let length=0;for await(const part of req){length+=part.length;if(length>16*1024*1024)return json(res,413,{error:{message:'Task request is too large'}});parts.push(part);}
      if(closed)return json(res,403,{error:{message:'Task has ended'}});
      let body=Buffer.concat(parts);
      if(inference){const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid request');value.model=gatewayModel(routing,value.model);body=Buffer.from(JSON.stringify(value));}
      const headers={'content-type':'application/json','content-length':body.length,authorization:`Bearer ${inference?clientKey:toolToken}`};
      if(inference){headers['x-api-key']=clientKey;headers['x-claude-code-session-id']=sessionId;
        for(const [name,value]of Object.entries(req.headers))if(typeof value==='string'&&(/^(?:anthropic-|x-stainless-)/.test(name)||['user-agent','x-app','x-client-request-id'].includes(name)))headers[name]=value;}
      const up=http.request({hostname:parent.hostname,port:parent.port,path:url.pathname+url.search,method:req.method,headers,timeout:300000,agent:false},response=>{
        res.writeHead(response.statusCode,{'content-type':response.headers['content-type']||'application/json','cache-control':'no-store'});response.pipe(res);
      });
      requests.add(up);up.once('close',()=>requests.delete(up));
      up.once('timeout',()=>up.destroy());up.once('error',()=>{if(res.headersSent)res.destroy();else json(res,502,{error:{message:'The local task service is unavailable'}});});
      res.once('close',()=>{if(!res.writableFinished)up.destroy();});up.end(body);
    }catch{if(!res.headersSent)json(res,400,{error:{message:'Invalid task request'}});else res.destroy();}
  });
  server.requestTimeout=300000;server.keepAliveTimeout=1000;
  server.on('connect',(req,socket,head)=>void network.tunnel(req,socket,head));server.on('upgrade',(req,socket)=>socket.destroy());
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin=`http://127.0.0.1:${server.address().port}`;
  return{origin,port:server.address().port,
    proxyURL:`http://project:${encodeURIComponent(toolToken)}@127.0.0.1:${server.address().port}`,
    async close(){closed=true;network.close();for(const req of requests)req.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
