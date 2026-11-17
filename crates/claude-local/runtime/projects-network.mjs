// Explicit, per-task network approvals. Only this trusted controller resolves
// and connects approved public hosts; the actor has no direct network route.
import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';
import {constantToken} from './hot-runtime.mjs';

export function publicAddress(address) {
  if(net.isIP(address)===4){const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
      a===192&&(b===168||b===0&&(c===0||c===2))||a===100&&b>=64&&b<=127||
      a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  return net.isIP(address)===6&&/^[23][a-f0-9]{3}:/i.test(address)&&!/^2001:db8:/i.test(address);
}

export function createProjectNetwork({parent,toolToken,jobId,resolveHost=host=>lookup(host,{all:true}),connect=options=>net.connect(options)}) {
  const approved=new Set(),pending=new Map(),connections=new Set(),parentRequests=new Set();let closed=false;
  const prefix=`/__codex_plus/projects-lab/jobs/${jobId}/tools`;
  const authorized=req=>{
    const value=String(req.headers['proxy-authorization']||'');
    return value.startsWith('Basic ')&&constantToken(Buffer.from(value.slice(6),'base64').toString(),`project:${toolToken}`)&&req.headers.origin===undefined;
  };
  function api(route,method,value) {
    return new Promise((resolve,reject)=>{
      const body=value===undefined?null:Buffer.from(JSON.stringify(value));
      const req=http.request({hostname:parent.hostname,port:parent.port,path:route,method,
        headers:{authorization:`Bearer ${toolToken}`,...body?{'content-type':'application/json','content-length':body.length}:{}},timeout:15000},res=>{
        const parts=[];let length=0;res.on('data',p=>{length+=p.length;if(length>64000)res.destroy();else parts.push(p);});
        res.once('error',reject);res.once('end',()=>{try{const data=JSON.parse(Buffer.concat(parts));if(res.statusCode!==200)reject(Error('Task permission unavailable'));else resolve(data);}catch(error){reject(error);}});
      });parentRequests.add(req);req.once('close',()=>parentRequests.delete(req));req.once('error',reject);req.once('timeout',()=>req.destroy());req.end(body);
    });
  }
  async function permission(hostname,port) {
    const key=`${hostname}:${port}`;if(approved.has(key))return true;if(pending.has(key))return pending.get(key);
    if(pending.size>=4||approved.size>=64)return false;
    const wait=(async()=>{
      try{
        const value=await api(prefix,'POST',{name:'approve',request_id:'network:'+key,input:{tool_name:'Network',input:{hostname,port,description:'Allow this Projects task to connect to this public host and port?'}}});
        for(let n=0;n<1200&&!closed;n++){
          const result=await api(prefix+'/'+value.id,'GET');
          if(result.state==='allowed'){approved.add(key);return true;}if(result.state==='denied')return false;
          await new Promise(r=>setTimeout(r,500));
        }
      }catch{}return false;
    })().finally(()=>pending.delete(key));pending.set(key,wait);return wait;
  }
  async function destination(req,raw,connectMode=false) {
    if(closed||!authorized(req))throw Error('Proxy authorization required');
    const url=new URL(connectMode?'https://'+raw:raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||connectMode&&(url.pathname!=='/'||url.search))throw Error('Invalid network destination');
    const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),port=Number(url.port||(url.protocol==='https:'?443:80));
    if(!port||port>65535||hostname==='localhost'||hostname.endsWith('.localhost')||hostname.endsWith('.local'))throw Error('Private network destinations are not allowed');
    const ip=net.isIP(hostname);if(ip&&!publicAddress(hostname))throw Error('Private network destinations are not allowed');
    // An unapproved hostname must not even cause a DNS query: otherwise DNS
    // itself becomes an exfiltration channel around the domain permission.
    if(!await permission(hostname,port)||closed)throw Error('Network access was not approved');
    const addresses=ip?[{address:hostname,family:ip}]:await resolveHost(hostname);
    if(closed)throw Error('Task has ended');
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('Private network destinations are not allowed');
    // Pin the resolved address, so a second DNS lookup cannot rebind to LAN,
    // loopback, the main Desktop proxy, or another local service.
    return{url,hostname,port,address:(addresses.find(a=>a.family===4)||addresses[0]).address};
  }
  function socket(target){if(closed)throw Error('Task has ended');const value=connect({host:target.address,port:target.port});connections.add(value);value.once('close',()=>connections.delete(value));return value;}
  return{
    async handle(req,res){
      try{
        const target=await destination(req,req.url);if(target.url.protocol!=='http:')throw Error('Use CONNECT for TLS');
        const headers={...req.headers,host:target.url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
        const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>socket(target);
        const up=http.request({hostname:target.hostname,port:target.port,path:target.url.pathname+target.url.search,method:req.method,headers,agent,timeout:120000},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
        up.once('error',()=>{if(res.headersSent)res.destroy();else{res.writeHead(502);res.end('Approved network connection failed');}});
        up.once('timeout',()=>up.destroy());res.once('close',()=>{up.destroy();agent.destroy();});req.pipe(up);
      }catch{if(!res.headersSent)res.writeHead(403);res.end('Network access requires task approval; private networks remain blocked');}
    },
    async tunnel(req,client,head){
      try{
        const target=await destination(req,req.url,true),up=socket(target);client.once('error',()=>up.destroy());
        up.once('error',()=>client.destroy());client.once('close',()=>up.destroy());up.once('close',()=>client.destroy());
        up.once('connect',()=>{if(client.destroyed)return up.destroy();client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)up.write(head);client.pipe(up);up.pipe(client);});
      }catch{if(!client.destroyed)client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
    },
    close(){closed=true;for(const req of parentRequests)req.destroy();for(const value of connections)value.destroy();}
  };
}
