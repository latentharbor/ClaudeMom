// Experimental, owned-project API. Enabled only by the isolated manager build.
// This service does not obtain official Projects eligibility or call its cloud.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { constantToken } from './hot-runtime.mjs';

const now = () => new Date().toISOString();
const id = prefix => prefix + crypto.randomUUID().replaceAll('-', '');
const channelId = /^chan_[A-Za-z0-9_-]{1,120}$/;
const messageId = /^cmsg_[A-Za-z0-9_-]{1,120}$/;
function json(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':bytes.length,
    'cache-control':'no-store', 'x-claudemom-projects-backend':'local-lab' });
  res.end(bytes);
}
async function body(req) {
  const parts = []; let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 2 * 1024 * 1024) throw Error('Project request exceeds the local limit');
    parts.push(part);
  }
  const value = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Project request must be an object');
  return value;
}
const page = data => ({ data, has_more:false, next_cursor:null });
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0,limit) : '';

export function createLocalProjects({ directory, accountId, models, clientKey, coordinator, onActiveChange = () => {} }) {
  fs.mkdirSync(directory, { recursive:true, mode:0o700 });
  const file = path.join(directory,'projects.json');
  let data = { schema:1, channels:[], messages:[], memories:[] };
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32*1024*1024) throw Error('Invalid project store');
    const saved = JSON.parse(fs.readFileSync(file));
    if (saved.schema !== 1 || !['channels','messages','memories'].every(k=>Array.isArray(saved[k]))) throw Error('Invalid project store schema');
    data = saved;
  }
  const listeners = new Map(), requests = [];
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > 32*1024*1024) throw Error('Local project store is full');
    const temporary = file+'.'+process.pid+'.next';
    fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,file);
  };
  function notify(channel, event) {
    for (const res of listeners.get(channel) || []) {
      if (!res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
  function find(channel) {
    if (!channelId.test(channel)) return null;
    return data.channels.find(c=>c.id===channel) || null;
  }
  function message(channel, values) {
    const row = { id:id('cmsg_'), channel_id:channel, body:'', created_at:now(), updated_at:now(),
      attachments:[], attached_outputs:[], ...values };
    data.messages.push(row);save();
    notify(channel,{type:'message',message:row});
    return row;
  }
  function stream(channel, req, res) {
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});
    res.write('event: keep_alive\ndata: {}\n\n');
    let peers = listeners.get(channel);if(!peers)listeners.set(channel,peers=new Set());peers.add(res);
    const timer=setInterval(()=>res.write('event: keep_alive\ndata: {}\n\n'),15000);timer.unref();
    res.once('close',()=>{clearInterval(timer);peers.delete(res);});
  }
  function matches(url) {
    return url.pathname.startsWith('/v1/code/channels') || url.pathname.startsWith('/v1/code/memory/channel/') ||
      url.pathname === '/__codex_plus/projects-lab/diagnostics';
  }
  async function handle(req,res,url) {
    const p=url.pathname.replace(/\/+$/,''), method=req.method;
    const origin=req.headers.origin;
    const ownedOrigin=origin==='https://claude.ai';
    const browserRead=method==='GET'&&origin===undefined&&req.headers['sec-fetch-site']==='same-origin'&&req.headers['sec-fetch-dest']==='empty';
    const localAuth=constantToken(String(req.headers.authorization||'').replace(/^Bearer /,''),clientKey);
    if((origin!==undefined&&!ownedOrigin)||(!ownedOrigin&&!browserRead&&!localAuth))return json(res,{error:{message:'Local project authorization required'}},403);
    if(['POST','PATCH','PUT'].includes(method)&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,{error:{message:'Project requests require JSON'}},415);
    requests.push({method,path:p});if(requests.length>200)requests.shift();
    if(p==='/__codex_plus/projects-lab/diagnostics')return json(res,{schema:1,backend:'local-lab',
      channels:data.channels.length,messages:data.messages.length,requests});
    if(p==='/v1/code/channels') {
      if(method==='GET')return json(res,page(data.channels.filter(c=>!c.archived_at)));
      if(method==='POST') {
        const input=await body(req),name=text(input.name,200);
        if(!name)return json(res,{error:{type:'invalid_request_error',message:'Project name is required'}},400);
        if(data.channels.length>=100)return json(res,{error:{message:'Local project limit reached'}},409);
        const channel={id:id('chan_'),name,topic:text(input.topic,2000),visibility:'private',created_at:now(),updated_at:now(),
          created_by_account_id:accountId,creator_account_id:accountId,member_count:1,members_truncated:false,
          members:[{account_id:accountId,role:'owner'}],context_sources:input.context_sources||[],
          system_prompt_addendum:text(input.system_prompt_addendum,64000),default_source_urls:input.default_source_urls||[],
          default_environment_id:input.default_environment_id||'env_claudemom_local',
          execution_backend:'claudemom-local',settings:{coordinator_mode_enabled:true,
            model_id:models().model,coordinator_model_id:models().smallModel||models().model,effort_level:'medium',coordinator_effort_level:'low',
            ...input.settings}};
        data.channels.push(channel);save();return json(res,{channel},201);
      }
    }
    const match=p.match(/^\/v1\/code\/channels\/(chan_[A-Za-z0-9_-]+)(.*)$/);
    if(match) {
      const [,channel,suffix]=match,c=find(channel);
      if(!c)return json(res,{error:{type:'not_found_error',message:'Local project not found'}},404);
      if(!suffix) {
        if(method==='GET')return json(res,{channel:c});
        if(method==='PATCH') {
          const input=await body(req);
          for(const key of ['name','topic','system_prompt_addendum','default_environment_id']) {
            if(typeof input[key]==='string')c[key]=text(input[key],key==='system_prompt_addendum'?64000:2000);
          }
          if(input.settings&&typeof input.settings==='object'&&!Array.isArray(input.settings))c.settings={...c.settings,...input.settings};
          if(input.archived===true)c.archived_at=now();
          if(input.archived===false)delete c.archived_at;
          c.updated_at=now();save();return json(res,{channel:c});
        }
        if(method==='DELETE') {
          data.channels=data.channels.filter(x=>x.id!==channel);data.messages=data.messages.filter(x=>x.channel_id!==channel);save();return json(res,{});
        }
      }
      if(suffix==='/messages/stream'&&method==='GET')return stream(channel,req,res);
      if(suffix==='/messages'&&method==='GET') {
        let rows=data.messages.filter(m=>m.channel_id===channel);
        const root=url.searchParams.get('thread_id')||url.searchParams.get('thread_root_id');
        if(root)rows=rows.filter(m=>m.id===root||m.thread_root_id===root||m.in_reply_to_message_id===root);
        if(url.searchParams.get('threads_only')==='true')rows=rows.filter(m=>m.thread_root_id===m.id);
        return json(res,page(rows));
      }
      if(suffix==='/messages'&&method==='POST') {
        if(!coordinator)return json(res,{error:{message:'The local coordinator is not connected yet'}},503);
        const input=await body(req),content=text(input.body??input.text??input.content,64000);
        if(!content)return json(res,{error:{message:'A text message is required'}},400);
        if(input.client_message_id) {
          const duplicate=data.messages.find(m=>m.channel_id===channel&&m.client_message_id===input.client_message_id);
          if(duplicate)return json(res,{message_id:duplicate.id});
        }
        const row=message(channel,{body:content,author_account_id:accountId,client_message_id:input.client_message_id,
          ...(input.in_reply_to_message_id?{in_reply_to_message_id:input.in_reply_to_message_id,thread_root_id:input.in_reply_to_message_id}:{})});
        void coordinator({channel:c,input:row,message:(values)=>message(channel,values)});
        return json(res,{message_id:row.id});
      }
      if(suffix.startsWith('/threads/')&&method==='GET') {
        const root=suffix.split('/')[2];
        if(!messageId.test(root))return json(res,{error:{message:'Invalid local thread'}},400);
        return json(res,page(data.messages.filter(m=>m.channel_id===channel&&(m.id===root||m.thread_root_id===root))));
      }
      if(suffix==='/client/presence')return json(res,{refresh_after_seconds:20,clients:[]});
      if(suffix==='/home_sections')return json(res,{home_sections:[]});
      if(suffix==='/artifacts')return json(res,page([]));
      if(suffix==='/usage')return json(res,{total_tokens:0,sessions:[],usage:[]});
      if(suffix==='/read'||suffix==='/messages:read')return json(res,{});
    }
    return json(res,{error:{type:'not_found_error',message:'Local Projects endpoint is not implemented',path:p}},404);
  }
  return {matches,handle, snapshot:()=>structuredClone(data), close:()=>{for(const peers of listeners.values())for(const res of peers)res.end();},
    active:()=>0};
}
