// Claude Desktop's channel API over DS Project's actual engine and Library.
// This facade is enabled only by the isolated lab build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {LocalDSProjects} from './projects-ds-core.mjs';
import {constantToken} from './hot-runtime.mjs';
import {nextOccurrence} from './projects-schedule.mjs';
import {libraryRoot,within,relativeName,libraryAction} from './third-party/ds-project/library.js';
import {saveMemory} from './third-party/ds-project/settings.js';
import {coordinatorToolDenial} from './third-party/ds-project/coordinator.js';
import {repositoryInfo} from './projects-worktree.mjs';
import {channelId,messageId,externalFileId,memoryId,sha,page,json,bytes,body,sourcePins} from './projects-protocol.mjs';

const now=()=>new Date().toISOString();
const validPath=value=>relativeName(String(value||'').replace(/^\/+|\/+$/g,''));
const active=job=>['running','queued'].includes(job.state);
export function createLocalProjects(options) {
  const {directory,clientKey,accountId,runner,clock=()=>Date.now(),scheduleInterval=1000}=options;
  const listeners=new Map(),previous=new Map(),requests=[];let core,closed=false,ticking=false,eventIndex=0;
  function notify(id,type,value) {for(const res of listeners.get(id)||[])if(!res.destroyed)res.write(`id: ${++eventIndex}\nevent: ${type}\ndata: ${JSON.stringify(value)}\n\n`);}
  function changed() {
    if(!core||closed)return;
    for(const p of core.engine.store.data.projects){const id=channelId(p.id);
      for(const row of core.messageDTOs(p)){const digest=sha(JSON.stringify(row)),prior=previous.get(row.id);
        if(prior!==digest){previous.set(row.id,digest);notify(id,prior?'channel_message_updated':'channel_message',row);}}
      notify(id,'local_project_state',{changed_at:now()});
    }
  }
  core=new LocalDSProjects({...options,onChange:changed});
  const state=p=>({channel:core.channelDTO(p),implementation:{name:'DS Project',...sourcePins},
    repository:p.repositoryPath?{...p.repositoryInfo,path:p.repositoryPath,managed:false}:{managed:true},
    threads:core.engine.store.data.threads.filter(t=>t.projectId===p.id&&t.kind!=='main').map(t=>core.threadDTO(t)),
    messages:core.messageDTOs(p),jobs:core.meta.jobs.filter(j=>j.channel_id===channelId(p.id)).map(({tool_token,directory,input_text,source_metadata,...job})=>job),
    schedules:core.meta.schedules.filter(s=>s.channel_id===channelId(p.id)),permissions:core.meta.permissions.filter(s=>s.channel_id===channelId(p.id)),
    files:core.files(p).filter(f=>!f.is_directory)});
  const thread=(p,id)=>core.engine.store.data.threads.find(t=>t.projectId===p.id&&(t.id===id||messageId(t.id)===id));
  function createSchedule(p,input) {
    if(core.meta.schedules.filter(s=>s.channel_id===channelId(p.id)).length>=100)throw Error('Local schedule limit reached');
    if(typeof input.name!=='string'||!input.name.trim()||typeof (input.prompt||input.text)!=='string'||!(input.prompt||input.text).trim())throw Error('A schedule name and prompt are required');
    const schedule={id:'trig_'+crypto.randomUUID().replaceAll('-',''),channel_id:channelId(p.id),name:input.name.trim(),prompt:input.prompt||input.text,
      timezone:input.timezone||'UTC',enabled:input.enabled!==false,created_at:now(),updated_at:now(),
      ...(input.run_once_at?{run_once_at:input.run_once_at}:{cron_expression:input.cron_expression})};
    schedule.next_run_at=nextOccurrence(schedule,clock());core.meta.schedules.push(schedule);core.save();core.changed();return schedule;
  }
  async function dispatchSchedule(p,s,occurrence) {
    const task=await core.launch(p,{title:s.name,prompt:s.prompt},s.id+':'+occurrence,'schedule');
    s.last_thread_id=messageId(task.id);delete s.pending_delivery;core.save();core.changed();
  }
  async function tick() {
    if(closed||ticking||!runner)return;ticking=true;
    try{for(const s of core.meta.schedules){
      const p=core.engine.store.data.projects.find(p=>channelId(p.id)===s.channel_id);if(!p||p.archived||p.paused)continue;
      if(s.pending_delivery){await dispatchSchedule(p,s,s.pending_delivery);continue;}
      if(!s.enabled||!s.next_run_at||Date.parse(s.next_run_at)>clock()||core.meta.jobs.filter(active).length>=32)continue;
      const occurrence=s.next_run_at;
      s.last_run_at=new Date(clock()).toISOString();s.last_occurrence=occurrence;s.pending_delivery=occurrence;
      if(s.run_once_at){s.enabled=false;s.next_run_at=null;}else s.next_run_at=nextOccurrence(s,clock());
      core.save();await dispatchSchedule(p,s,occurrence);
    }}catch(error){core.meta.schedule_error=error.message;core.save();}finally{ticking=false;}
  }
  const timer=scheduleInterval>0?setInterval(()=>void tick(),scheduleInterval):null;timer?.unref();
  function matches(url) {
    return url.pathname.startsWith('/v1/code/channels')||url.pathname.startsWith('/v1/code/memory/channel/')||url.pathname.startsWith('/v1/code/triggers')||
      url.pathname.startsWith('/__codex_plus/projects-lab/')||(/^\/api\/[^/]+\/upload$/.test(url.pathname)&&url.searchParams.get('store_as_is')==='true');
  }
  function authenticate(req) {
    const origin=req.headers.origin,owned=origin==='https://claude.ai',read=req.method==='GET'&&origin===undefined&&
      req.headers['sec-fetch-site']==='same-origin'&&req.headers['sec-fetch-dest']==='empty';
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
    return (origin===undefined||owned)&&(owned||read||constantToken(token,clientKey));
  }
  async function upload(req,res) {
    const raw=await bytes(req),contentType=req.headers['content-type'];
    const form=await new Response(raw,{headers:{'content-type':contentType}}).formData(),file=form.get('file');
    if(!file||typeof file.arrayBuffer!=='function'||file.size>8*1024*1024)throw Error('A file of up to 8 MiB is required');
    const uuid=crypto.randomUUID(),name=relativeName(file.name),id=externalFileId(uuid),home=path.join(directory,'uploads');
    fs.mkdirSync(home,{recursive:true,mode:0o700});fs.writeFileSync(path.join(home,uuid),Buffer.from(await file.arrayBuffer()),{mode:0o600,flag:'wx'});
    const receipt={file_uuid:uuid,file_id:id,filename:name,mime_type:file.type||'application/octet-stream',size_bytes:file.size,created_at:now()};
    core.meta.uploads.push(receipt);core.save();return json(res,receipt);
  }
  async function writeFiles(p,input) {
    if(!Array.isArray(input.files)||!input.files.length||input.files.length>100)throw Error('Invalid Library batch');
    const validated=input.files.map(f=>{
      const name=validPath(f.path);let content=f.content;
      if(f.source_file_id){const receipt=core.meta.uploads.find(u=>u.file_id===f.source_file_id);if(!receipt)throw Error('Unknown source_file_id');content=fs.readFileSync(path.join(directory,'uploads',receipt.file_uuid)).toString('base64');}
      if(typeof content!=='string'||content.length>Math.ceil(8*1024*1024/3)*4||Buffer.from(content,'base64').toString('base64')!==content)throw Error('Invalid Library content');
      return{name,content,overwrite:f.overwrite===true,sourceFileId:f.source_file_id};
    });
    if(new Set(validated.map(f=>f.name.normalize('NFC').toLowerCase())).size!==validated.length)throw Error('Duplicate paths in Library batch');
    let size=core.files(p).reduce((n,f)=>n+(f.size_bytes||0),0);
    for(const file of validated){const existing=core.files(p).find(f=>f.path===file.name);size+=Buffer.from(file.content,'base64').length-(existing&&file.overwrite?existing.size_bytes:0);}
    if(size>24*1024*1024)throw Error('Project Library capacity reached');
    const results=validated.map(f=>core.importFile(p,f.name,f.content,f));return{results};
  }
  const normalTools={start_thread_session:'project_launch_task',list_thread_sessions:'project_list_threads',send_message:'project_send_to_thread',fetch_messages:'project_read_context',
    read_memory:'project_memory_file',write_memory:'project_memory_file',list_project_files:'project_read_context',read_project_file:'project_read_context'};
  async function tool(job,name,input,requestId) {
    const p=core.project(job.channel_id),t=core.engine.store.thread(job.ds_thread_id,p.id),key=job.id+':'+name+':'+requestId+':'+sha(JSON.stringify(input));
    const cached=core.meta.actions.find(a=>a.key===key);if(cached)return cached.value;
    const canonical=normalTools[name]||name;
    if(t.kind==='main'&&name!=='approve'&&!['create_schedule','list_schedules'].includes(name)){
      const denial=coordinatorToolDenial(canonical);if(denial)throw Error(denial);
    }
    let value;
    switch(canonical) {
      case 'approve': {
        if(typeof input.tool_name!=='string'||!input.input||typeof input.input!=='object')throw Error('Invalid permission prompt');
        const permission={id:'perm_'+crypto.randomUUID().replaceAll('-',''),channel_id:job.channel_id,job_id:job.id,
          thread_id:t.kind==='main'?undefined:messageId(t.id),tool_name:input.tool_name,input:input.input,state:'pending',requested_at:now()};
        core.meta.permissions.push(permission);t.status='approval';core.engine.store.save();value={id:permission.id};break;
      }
      case 'project_launch_task': {
        const child=await core.launch(p,{title:input.title,prompt:input.brief||input.prompt},key,'coordinator',t);
        value=name==='start_thread_session'?core.threadDTO(child):{taskId:child.id,thread_id:messageId(child.id)};break;
      }
      case 'project_list_threads':value={threads:core.engine.store.data.threads.filter(s=>s.projectId===p.id&&s.kind!=='main').map(s=>({...core.threadDTO(s),taskId:s.id}))};break;
      case 'project_send_to_thread': {
        const target=thread(p,input.thread_id||input.task_id||input.id);if(!target)throw Error('Unknown project thread');
        value=await core.engine.route(t.sessionId,target.id,input.body||input.message,key);break;
      }
      case 'project_update_thread': {
        const target=thread(p,input.thread_id||input.task_id||input.id);if(!target)throw Error('Unknown project thread');
        value=await core.engine.updateThread(t.sessionId,target.id,input.action);break;
      }
      case 'project_read_context': {
        if(name==='list_project_files'){value={files:core.files(p)};break;}
        if(name==='read_project_file'){const name=validPath(input.path),raw=fs.readFileSync(within(libraryRoot(p),name));
          const offset=Number.isSafeInteger(input.offset)&&input.offset>=0?input.offset:0,len=Math.min(Math.max(input.length||64000,1),64000);
          value={path:name,content:raw.subarray(offset,offset+len).toString('utf8'),size_bytes:raw.length,next_offset:offset+len<raw.length?offset+len:null};break;}
        const target=input.thread_id?thread(p,input.thread_id):null;
        value=core.engine.readContext(t.sessionId,{...input,...target?{task_id:target.id}:{}});break;
      }
      case 'project_search_history':value=core.engine.searchHistory(t.sessionId,input);break;
      case 'project_read_activity':value=core.engine.readActivity(t.sessionId,input);break;
      case 'project_remember':value=core.engine.store.memory(p.id,input.text||input.memory,{type:'agent',threadId:t.id},true);break;
      case 'project_forget': {
        const memory=p.memories.find(m=>m.id===input.id);if(!memory)throw Error('Memory not found');
        value=core.engine.store.decideMemory(p.id,memory.id,'removed',input.expected_revision??memory.revision);break;
      }
      case 'project_memory_file': {
        const action=name==='read_memory'?(input.path?'read':'list'):name==='write_memory'?'write':input.action||'list';
        if(action==='list'){value={memories:core.memory(p)};break;}
        const name=String(input.path||input.name||'MEMORY.md').replace(/^\//,'');
        if(action==='read'){value=core.memory(p).find(m=>m.path==='/'+name);if(!value)throw Error('Memory file not found');}
        else if(action==='write')value=core.writeMemory(p,name,input.content,input.expected_sha256);
        else if(action==='delete'){saveMemory(core.engine.store,p,{name,remove:true,confirmName:name});value={removed:true};}
        else throw Error('Unknown memory action');break;
      }
      case 'project_finish_task':value=core.engine.finish(t.sessionId,input.summary,input.needs_input,input.resolved);break;
      case 'project_publish_file': {
        value=core.engine.publish(t.sessionId,input.path);value.source={...value.source,jobId:job.id};core.engine.store.save();break;
      }
      case 'create_schedule':value=createSchedule(p,input);break;
      case 'list_schedules':value={schedules:core.meta.schedules.filter(s=>s.channel_id===job.channel_id)};break;
      default:throw Error('Unknown local project tool');
    }
    core.meta.actions.push({key,value});if(core.meta.actions.length>10000)core.meta.actions.shift();core.save();core.changed();return value;
  }
  async function internal(req,res,url,match) {
    const job=core.meta.jobs.find(j=>j.id===match[1]),token=String(req.headers.authorization||'').replace(/^Bearer /,'');
    if(req.headers.origin!==undefined||!job||!constantToken(token,job.tool_token))return json(res,{error:{message:'Local task authorization required'}},403);
    if(job.state!=='running')return json(res,{error:{message:'Local task ended'}},410);
    if(match[2]&&req.method==='GET'){const permission=core.meta.permissions.find(p=>p.id===match[2]&&p.job_id===job.id);return permission?json(res,{state:permission.state}):json(res,{error:{message:'Permission expired'}},410);}
    if(req.method!=='POST')return json(res,{},405);const input=await body(req);return json(res,await tool(job,input.name,input.input||{},String(input.request_id||'')));
  }
  async function handle(req,res,url) {
    const name=url.pathname.replace(/\/+$/,''),method=req.method;
    const task=name.match(/^\/__codex_plus\/projects-lab\/jobs\/([a-f0-9-]{36})\/tools(?:\/(perm_[A-Za-z0-9_-]+))?$/);
    if(task)return internal(req,res,url,task);
    if(!authenticate(req))return json(res,{error:{message:'Local project authorization required'}},403);
    requests.push({method,path:name});if(requests.length>200)requests.shift();
    if(name==='/__codex_plus/projects-lab/diagnostics')return json(res,{schema:2,backend:'ds-project-local',sourcePins,
      channels:core.engine.store.data.projects.length,messages:core.engine.store.data.threads.reduce((n,t)=>n+t.messages.length,0),requests});
    if(/^\/api\/[^/]+\/upload$/.test(name)&&method==='POST')return upload(req,res);
    if(['POST','PATCH','PUT'].includes(method)&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,{error:{message:'JSON content type required'}},415);
    if(name==='/v1/code/channels') {
      if(method==='GET')return json(res,page(core.engine.store.data.projects.filter(p=>url.searchParams.get('include_archived')==='true'||!p.archived).map(p=>core.channelDTO(p))));
      if(method==='POST')return json(res,{channel:core.channelDTO(await core.create(await body(req)))},201);
    }
    if(name==='/v1/code/triggers'&&method==='GET')return json(res,{triggers:core.meta.schedules,...page(core.meta.schedules)});
    const trigger=name.match(/^\/v1\/code\/triggers\/(trig_[A-Za-z0-9_-]+)(\/run)?$/);
    if(trigger){const schedule=core.meta.schedules.find(s=>s.id===trigger[1]);if(!schedule)return json(res,{error:{message:'Schedule not found'}},404);
      const p=core.project(schedule.channel_id);
      if(trigger[2]&&method==='POST'){const t=await core.launch(p,{title:schedule.name,prompt:schedule.prompt},crypto.randomUUID(),'schedule_manual');return json(res,{trigger:schedule,thread:core.threadDTO(t)});}
      if(method==='DELETE'){core.meta.schedules=core.meta.schedules.filter(s=>s!==schedule);core.save();core.changed();return json(res,{});}
      if(['POST','PATCH'].includes(method)){const patch=await body(req),next={...schedule};for(const key of ['name','prompt','enabled','timezone','cron_expression','run_once_at'])if(patch[key]!==undefined)next[key]=patch[key];
        if(patch.cron_expression)delete next.run_once_at;if(patch.run_once_at)delete next.cron_expression;
        next.next_run_at=nextOccurrence(next,clock());Object.assign(schedule,next,{updated_at:now()});core.save();core.changed();}
      return json(res,{trigger:schedule});
    }
    const memory=name.match(/^\/v1\/code\/memory\/channel\/(chan_[A-Za-z0-9_-]+)\/memories(?:\/(mem_[A-Za-z0-9_-]+))?$/);
    if(memory){const p=core.project(memory[1]),items=core.memory(p),entry=memory[2]?items.find(m=>m.id===memory[2]):null;
      if(memory[2]&&!entry)return json(res,{error:{message:'Memory not found'}},404);
      if(method==='GET')return json(res,memory[2]?entry:{data:items,next_page:null});
      if(method==='POST'){const input=await body(req),pre=input.precondition;
        if(!memory[2]&&pre?.type!=='not_exists')return json(res,{error:{message:'Memory creation requires not_exists'}},400);
        if(memory[2]&&(pre?.type!=='content_sha256'||pre.content_sha256!==entry.content_sha256))return json(res,{error:{message:'Memory version conflict'}},409);
        if(!memory[2]&&items.some(m=>m.path===(input.path.startsWith('/')?input.path:'/'+input.path)))return json(res,{error:{message:'Memory already exists'}},409);
        return json(res,core.writeMemory(p,entry?.path||input.path,input.content,entry?pre.content_sha256:undefined,!entry),entry?200:201);
      }
      if(method==='DELETE'){const input=req.headers['content-length']?await body(req):{};const expected=input.expected_content_sha256||url.searchParams.get('expected_content_sha256');
        if(expected!==entry.content_sha256)return json(res,{error:{message:'Memory version conflict'}},409);
        saveMemory(core.engine.store,p,{name:entry.path.slice(1),remove:true,confirmName:entry.path.slice(1)});return json(res,{});}
    }
    const match=name.match(/^\/v1\/code\/channels\/(chan_[A-Za-z0-9_-]+)(.*)$/);
    if(!match)return json(res,{error:{message:'Local Projects endpoint is not implemented',path:name}},404);
    const [,id,suffix]=match;let p;try{p=core.project(id);}catch{return json(res,{error:{message:'Project not found'}},404);}
    if(!suffix){
      if(method==='GET')return json(res,{channel:core.channelDTO(p)});
      if(method==='PATCH'){const input=await body(req);for(const [from,to]of [['name','name'],['topic','description'],['system_prompt_addendum','instructions']])if(typeof input[from]==='string')p[to]=input[from];
        if(input.settings)p.channelConfig={...core.config(p),...input.settings};if(input.archived!==undefined)p.archived=input.archived===true;
        if(input.context_sources)p.contextSources=input.context_sources;if(input.clear_context_sources)p.contextSources=[];core.engine.store.save();return json(res,{channel:core.channelDTO(p)});}
      if(method==='DELETE'){if(core.meta.jobs.some(j=>j.channel_id===id&&active(j)))return json(res,{error:{message:'Stop local tasks before deleting this project'}},409);
        await core.engine.deleteProject(p.id,p.name);core.meta.schedules=core.meta.schedules.filter(s=>s.channel_id!==id);core.save();return json(res,{});}
    }
    if(suffix==='/local'&&method==='GET')return json(res,state(p));
    if(suffix==='/config'){
      if(method==='PATCH'){const input=await body(req);let repo;
        if(input.local_repository!==undefined){if(core.meta.jobs.some(j=>j.channel_id===id&&active(j)))return json(res,{error:{message:'Wait for current tasks before changing repository'}},409);repo=input.local_repository?repositoryInfo(input.local_repository):null;}
        if(typeof input.system_prompt_addendum==='string')p.instructions=input.system_prompt_addendum;
        p.channelConfig={...core.config(p),...input.settings};if(typeof input.settings?.instructions==='string')p.instructions=input.settings.instructions;
        if(input.local_repository!==undefined){p.repositoryPath=repo?.root||null;p.repositoryInfo=repo;}
        core.engine.store.save();}
      return json(res,{settings:core.config(p),system_prompt_addendum:p.instructions,context_sources:p.contextSources||[],local_repository:p.repositoryPath,
        default_environment_id:'env_claudemom_local',default_source_urls:p.sourceUrls||[],memory_enabled:true});
    }
    if(suffix==='/cancel'&&method==='POST'){for(const t of core.engine.store.data.threads.filter(t=>t.projectId===p.id))await core.cancelThread(t);return json(res,{cancelled:true});}
    if(suffix==='/permissions'&&method==='GET')return json(res,{permissions:core.meta.permissions.filter(p=>p.channel_id===id)});
    const permission=suffix.match(/^\/permissions\/(perm_[A-Za-z0-9_-]+)$/);
    if(permission&&method==='POST'){const item=core.meta.permissions.find(q=>q.id===permission[1]&&q.channel_id===id),job=core.meta.jobs.find(j=>j.id===item?.job_id);
      if(!item)return json(res,{error:{message:'Permission not found'}},404);
      if(item.state!=='pending'||job?.state!=='running')return json(res,{error:{message:'Permission is no longer pending'}},409);
      const input=await body(req);if(!['allow','deny'].includes(input.decision))throw Error('Choose allow or deny');
      item.state=input.decision==='allow'?'allowed':'denied';item.decided_at=now();
      const t=core.engine.store.thread(job.ds_thread_id);if(!core.meta.permissions.some(q=>q.job_id===job.id&&q.state==='pending'))t.status='running';
      core.save();core.engine.store.save();return json(res,{permission:item});}
    if(suffix==='/schedules'){if(method==='GET')return json(res,{schedules:core.meta.schedules.filter(s=>s.channel_id===id)});
      if(method==='POST')return json(res,{trigger:createSchedule(p,await body(req))},201);}
    if(suffix==='/threads'){
      if(method==='POST')return json(res,{thread:core.threadDTO(await core.launch(p,await body(req)))},201);
      const threads=core.engine.store.data.threads.filter(t=>t.projectId===p.id&&t.kind!=='main');
      return json(res,{...page(core.messageDTOs(p).filter(m=>m.id===m.thread_root_id)),threads:threads.map(t=>core.threadDTO(t))});
    }
    const taskThread=suffix.match(/^\/threads\/(cmsg_[A-Za-z0-9_-]+)(\/cancel)?$/);
    if(taskThread){const t=core.thread(taskThread[1],p);
      if(taskThread[2]&&method==='POST'){await core.cancelThread(t);return json(res,{thread:core.threadDTO(t)});}
      if(method==='PATCH'){const input=await body(req);if(input.display_name)t.title=input.display_name;
        if(input.resolved!==undefined)core.engine.setThreadStatus(p.id,t.id,input.resolved?'resolve':'reopen');core.engine.store.save();return json(res,{thread:core.threadDTO(t)});}
      if(method==='DELETE')return json(res,{error:{message:'Archive the thread with resolve; worktrees are retained for review'}},409);
      return json(res,page(core.messageDTOs(p).filter(m=>m.id===taskThread[1]||m.thread_root_id===taskThread[1])));
    }
    if(['/timeline','/messages'].includes(suffix)&&method==='GET'){
      let rows=core.messageDTOs(p);const root=url.searchParams.get('thread_id')||url.searchParams.get('thread_root_id');
      if(root)rows=rows.filter(m=>m.id===root||m.thread_root_id===root);else if(suffix==='/timeline')rows=rows.filter(m=>m.in_timeline);
      if(url.searchParams.get('thread_roots_only')==='true')rows=rows.filter(m=>m.thread_root_id===m.id);return json(res,page(rows));
    }
    if(suffix==='/messages'&&method==='POST'){const input=await body(req);if(typeof input.body!=='string'||!input.body.trim())throw Error('A message is required');
      if(!runner)return json(res,{error:{message:'Local CLI executor is unavailable'}},503);
      const result=await core.send(p,input.body,input.client_message_id||crypto.randomUUID(),input.in_reply_to_message_id);
      return json(res,{message_id:messageId(result.messageId),...input.in_reply_to_message_id?{thread_root_id:input.in_reply_to_message_id}:{}});
    }
    if(suffix==='/messages/stream'&&method==='GET'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});res.write('event: caught_up\ndata: {}\n\n');
      let peers=listeners.get(id);if(!peers)listeners.set(id,peers=new Set());peers.add(res);const interval=setInterval(()=>res.write('event: keep_alive\ndata: {}\n\n'),15000);interval.unref();
      res.once('close',()=>{clearInterval(interval);peers.delete(res);});return;
    }
    if(suffix==='/files:write'&&method==='POST')return json(res,await writeFiles(p,await body(req)));
    if(suffix==='/files:list'&&method==='POST'){
      const input=await body(req),limit=input.limit??500;if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Library limit must be between 1 and 500');
      const prefix=input.path?String(input.path).replace(/^\/+|\/+$/g,''):'',all=core.files(p).filter(f=>(!prefix||f.path.startsWith(prefix+'/'))&&
        (input.recursive===true||!(prefix?f.path.slice(prefix.length+1):f.path).includes('/'))),offset=input.cursor?Number(Buffer.from(input.cursor,'base64url').toString()):0;
      if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid Library cursor');return json(res,{entries:all.slice(offset,offset+limit),cursor:offset+limit<all.length?Buffer.from(String(offset+limit)).toString('base64url'):null});
    }
    if(suffix==='/files/usage'||suffix==='/headroom'){const files=core.files(p),used=files.reduce((n,f)=>n+(f.size_bytes||0),0);return json(res,{used_bytes:used,total_bytes:used,limit_bytes:24*1024*1024,remaining_bytes:Math.max(0,24*1024*1024-used),file_count:files.filter(f=>!f.is_directory).length});}
    if(suffix==='/files:open'&&method==='POST'){const input=await body(req),name=validPath(input.path),raw=fs.readFileSync(within(libraryRoot(p),name));
      const offset=Number.isSafeInteger(input.range_offset)&&input.range_offset>=0?input.range_offset:0,len=Number.isSafeInteger(input.range_length)&&input.range_length>0?input.range_length:raw.length;
      const content=raw.subarray(offset,offset+len).toString('base64');return json(res,{type:'content',data:content,content,encoding:'base64',size_bytes:raw.length,content_sha256:sha(raw),path:name});}
    const attachment=suffix.match(/^\/attachments\/(file_01[A-Za-z0-9]+)\/content$/);
    if(attachment&&method==='GET'){const file=core.files(p).find(f=>f.file_id===attachment[1]);
      if(!file)return json(res,{error:{message:'File version not found'}},404);
      const raw=fs.readFileSync(within(libraryRoot(p),file.path));return json(res,{type:'content',data:raw.toString('base64'),size_bytes:raw.length,filename:path.basename(file.path)});}
    if(suffix==='/files:mkdir'&&method==='POST'){const input=await body(req),name=validPath(input.path);fs.mkdirSync(within(libraryRoot(p),name,true),{recursive:true,mode:0o700});core.engine.store.save();return json(res,{path:name,is_directory:true});}
    if(suffix==='/files:delete'&&method==='POST'){const input=await body(req),name=validPath(input.path),target=within(libraryRoot(p),name);
      if(fs.existsSync(target)&&fs.statSync(target).isDirectory()&&!input.recursive&&fs.readdirSync(target).length)return json(res,{error:{message:'Folder is not empty'}},409);
      if(fs.existsSync(target))libraryAction(core.engine.store,p,{action:'delete',path:name,confirmName:path.basename(name)});return json(res,{});}
    if(suffix==='/files:move'&&method==='POST'){const input=await body(req),from=validPath(input.source_path),to=validPath(input.destination_path);
      if(to.startsWith(from+'/'))throw Error('Cannot move a folder into itself');if(fs.existsSync(within(libraryRoot(p),to,true)))return json(res,{error:{message:'Destination exists'}},409);
      libraryAction(core.engine.store,p,{action:'rename',path:from,to});return json(res,{path:to});}
    if(suffix==='/files:beginUpload')return json(res,{allowed:true,max_file_bytes:8*1024*1024,max_total_bytes:24*1024*1024});
    if(suffix==='/usage'){const usage=await core.usage(p);return json(res,{...usage,total_tokens:usage.total,sessions:usage.rows,usage:usage.rows});}
    if(suffix==='/client/presence')return json(res,{refresh_after_seconds:20,clients:[]});
    if(suffix==='/home_sections')return json(res,{home_sections:[]});
    if(['/artifacts','/attachments','/pull_requests'].includes(suffix))return json(res,page([]));
    if(['/read','/messages:read','/mark_read'].includes(suffix))return json(res,{});
    return json(res,{error:{message:'Local Projects endpoint is not implemented',path:name}},404);
  }
  return{matches,handle:async(req,res,url)=>{try{return await handle(req,res,url);}catch(error){if(!res.headersSent)return json(res,{error:{message:error.message}},400);res.end();}},tick,
    snapshot:()=>core.snapshot(),core,active:()=>core.meta.jobs.filter(active).length,
    close(){closed=true;clearInterval(timer);core.close();for(const peers of listeners.values())for(const res of peers)res.end();}};
}
