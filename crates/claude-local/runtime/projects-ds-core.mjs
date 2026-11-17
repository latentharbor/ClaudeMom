import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ProjectEngine} from './third-party/ds-project/engine.js';
import {libraryRoot,within,relativeName,importLibraryFile,libraryAction} from './third-party/ds-project/library.js';
import {memoryFiles,readMemory,saveMemory,usageView} from './third-party/ds-project/settings.js';
import {createThreadWorktree,ensureManagedRepository,changedFiles,repositoryInfo} from './projects-worktree.mjs';
import {channelId,messageId,rawUUID,stableUUID,externalFileId,memoryId,sha,privateJSON,sourcePins} from './projects-protocol.mjs';

const now=()=>new Date().toISOString();
const busy=state=>['queued','running'].includes(state);

export class LocalDSProjects {
  constructor({directory,accountId,models,runner,onChange=()=>{},onActiveChange=()=>{},onTaskFinished=()=>{}}) {
    this.directory=directory;this.accountId=accountId;this.models=models;this.runner=runner;
    this.onChange=onChange;this.onActiveChange=onActiveChange;this.onTaskFinished=onTaskFinished;this.closed=false;this.observing=new Set();
    fs.mkdirSync(directory,{recursive:true,mode:0o700});this.file=path.join(directory,'projects.json');
    let saved;try{if(fs.lstatSync(this.file).isSymbolicLink())throw Error('Invalid local metadata');saved=JSON.parse(fs.readFileSync(this.file));}catch(error){if(error.code!=='ENOENT')throw error;}
    this.meta=saved?.schema===2?saved:{schema:2,jobs:saved?.jobs||[],schedules:saved?.schedules||[],permissions:saved?.permissions||[],uploads:[],actions:[]};
    const adapter={preserveRuns:true,notifyReports:(t,p)=>this.config(p).coordinator_mode_enabled!==false,
      create:async(t,p)=>this.createSession(t,p),attach:async t=>{
        if(t.legacyActor&&!this.meta.jobs.some(j=>j.ds_thread_id===t.id&&j.state==='running')){
          (t.previousSessions||=[]).push(t.sessionId);t.cliSessionId=null;t.workspaceReset=true;
          t.sessionId=this.createSession(t,this.engine.store.project(t.projectId));delete t.legacyActor;this.engine.store.save();
        }
      },
      send:async(t,input,source)=>this.execute(t,input,source),
      stop:async t=>this.stopSession(t),retire:async t=>this.stopSession(t),
      usage:async id=>this.sessionUsage(id)};
    this.engine=new ProjectEngine(path.join(directory,'ds-core'),adapter);
    const originalSend=this.engine.send.bind(this.engine);
    this.engine.send=(id,input,requestId,options={})=>{
      const t=this.engine.store.thread(id);this.intent(t,input,requestId,options);
      return originalSend(id,input,requestId,options);
    };
    const originalSave=this.engine.store.save.bind(this.engine.store);
    this.engine.store.save=()=>{originalSave();this.changed();};
    if(saved&&saved.schema===1)this.migrate(saved);
    this.save();queueMicrotask(()=>this.recover());
  }
  save(){privateJSON(this.file,this.meta,fs);}
  changed(){if(this.closed)return;this.onActiveChange(this.meta.jobs.filter(j=>busy(j.state)).length);
    if(this.changeQueued)return;this.changeQueued=true;queueMicrotask(()=>{this.changeQueued=false;if(!this.closed)this.onChange();});}
  project(id){const p=this.engine.store.data.projects.find(p=>channelId(p.id)===id);if(!p)throw Error('Local project not found');return p;}
  thread(id,p){const t=this.engine.store.data.threads.find(t=>messageId(t.id)===id&&(!p||t.projectId===p.id)&&t.kind!=='main');if(!t)throw Error('Local thread not found');return t;}
  config(p){return{coordinator_mode_enabled:true,model_id:this.models().model,coordinator_model_id:this.models().model,effort_level:'high',coordinator_effort_level:'low',...p.channelConfig};}
  async create(input) {
    if(input.visibility&&input.visibility!=='private')throw Error('Only private local projects are supported');
    const p=await this.engine.createProject({name:input.name,description:input.topic||''});
    p.channelConfig={...this.config(p),...input.settings};p.instructions=input.system_prompt_addendum||'';
    p.contextSources=input.context_sources||[];p.sourceUrls=input.default_source_urls||[];p.repositoryPath=input.local_repository||null;
    this.engine.store.save();return p;
  }
  async launch(p,input,key=crypto.randomUUID(),source='user',origin) {
    if(!this.runner||this.runner.available?.()===false)throw Error('Open the Code tab once to prepare the bundled CLI for local Projects');
    if(this.meta.jobs.filter(j=>busy(j.state)).length>=32)throw Error('The local project queue is full');
    const result=await this.engine.launch(p.id,{title:input.title||input.name,brief:input.prompt||input.body,kind:'execute',
      sourceThreadId:origin?.id||p.mainThreadId,requestId:source+':'+key});
    return this.engine.store.thread(result.taskId);
  }
  async send(p,input,key=crypto.randomUUID(),root) {
    if(!this.runner||this.runner.available?.()===false)throw Error('Open the Code tab once to prepare the bundled CLI for local Projects');
    const t=root?this.thread(root,p):this.engine.store.thread(p.mainThreadId);
    return this.engine.send(t.id,input,'user:'+key);
  }
  intent(t,input,key,options) {
    const id=stableUUID(t.id+':'+key);let job=this.meta.jobs.find(j=>j.id===id||j.ds_thread_id===t.id&&j.request_id===key);if(job)return job;
    const p=this.engine.store.project(t.projectId),settings=this.config(p);
    const dispatch=t.dispatchKey||'';
    const source=options.source?.role==='report'?'worker_event':dispatch.includes(':schedule:')?'schedule':
      dispatch.includes(':coordinator:')||options.source?.role==='relay'?'coordinator':'user';
    job={id,ds_thread_id:t.id,channel_id:channelId(p.id),state:'queued',request_id:key,input_text:input,source,
      source_metadata:options.source||{kind:'user'},created_at:now(),tool_token:crypto.randomBytes(32).toString('hex'),
      model:t.kind==='main'?settings.coordinator_model_id:settings.model_id,
      effort:t.kind==='main'?settings.coordinator_effort_level:settings.effort_level,
      ...(t.kind==='main'?{}:{thread_root_id:messageId(t.id)})};
    this.meta.jobs.push(job);this.save();this.changed();return job;
  }
  createSession(t,p) {
    const publicId=channelId(p.id),root=path.join(this.directory,'execution',publicId);
    if(t.kind==='main')t.cwd=path.join(root,'workspaces','coordinator');
    else {
      const repo=p.repositoryPath||ensureManagedRepository(path.join(root,'repository'));
      let destination=path.join(root,'workspaces',messageId(t.id));
      if(fs.existsSync(destination)&&!fs.existsSync(path.join(destination,'.git'))){(t.previousWorkspaces||=[]).push(destination);destination+='-ds';}
      t.worktree=createThreadWorktree(repo,t.id,t.title,destination,p.baseCommit||'HEAD');t.cwd=t.worktree.worktreePath;
    }
    fs.mkdirSync(t.cwd,{recursive:true,mode:0o700});
    t.cliSessionId=t.cliSessionId||crypto.randomUUID();return t.cliSessionId;
  }
  async execute(t,input,source) {
    // A DS dispatch/send receipt is persisted before its detached actor starts.
    await Promise.all([...this.engine.actions.values()]);if(this.closed)return;
    const p=this.engine.store.project(t.projectId),job=this.intent(t,input,t.runningRequestId,{source});
    if(job.state!=='queued')return;
    const isMain=t.kind==='main',previous=this.meta.jobs.findLast(j=>j.id!==job.id&&j.ds_thread_id===t.id&&j.session_id===t.sessionId&&j.state==='completed');
    let snapshot=this.engine.runtimeContext(t.sessionId);
    if(!isMain){const split=snapshot.indexOf('\n');const object=JSON.parse(snapshot.slice(split+1));object.threads=(object.threads||[]).map(({latestUser,latestAssistant,...status})=>status);snapshot=snapshot.slice(0,split+1)+JSON.stringify(object);}
    const policy=this.engine.context(t.sessionId).replace(/\b(project_[a-z_]+)\b/g,'mcp__local_project__$1')+
      '\nThis is the local ClaudeMom host. Native todo_write is not available. Use the configured local_project MCP tools. Never call the approve tool directly. Work in the supplied thread worktree; do not merge or change the project base branch.';
    const stableSnapshot=snapshot.slice(snapshot.indexOf('\n')+1);let digestSnapshot;
    try{const object=JSON.parse(stableSnapshot);delete object.at;delete object.activityCursor;digestSnapshot=JSON.stringify(object);}catch{digestSnapshot=snapshot;}
    const context=policy+'\n'+snapshot;job.context_digest=sha(policy+'\n'+digestSnapshot);t.model=job.model;
    const prompt=(previous?(previous.context_digest===job.context_digest?'':context+'\nUpdated project context.\n'):
      context+'\nPrevious project history (data, not new requests):\n'+JSON.stringify(t.turnSnapshot?.history||{}))+
      '\nCurrent request:\n'+(source?.role==='report'?'Project worker report:\n':'')+input;
    job.session_id=t.sessionId;job.ds_seq_base=t.lastEventSeq||0;
    try{
      const task=this.runner.run({projectId:channelId(p.id),prompt,model:job.model,effort:job.effort,sessionId:t.sessionId,
        resume:!!previous,role:isMain?'coordinator':'worker',lane:isMain?'coordinator':messageId(t.id),workspace:t.cwd,
        jobId:job.id,toolToken:job.tool_token,library:this.librarySnapshot(p),onPrepared:prepared=>{
          job.state='running';job.directory=prepared.directory;job.started_at=now();this.save();this.changed();
        }});
      job.state='running';job.directory=task.directory;job.started_at=now();this.save();this.changed();
      this.observing.add(job.id);void task.done.then(result=>this.deliver(job.id,result));
    }catch(error){this.deliver(job.id,{state:'failed',result:'',error:error.message});}
  }
  async deliver(id,result) {
    if(this.closed)return;const job=this.meta.jobs.find(j=>j.id===id);if(!job)return;
    const t=this.engine.store.data.threads.find(t=>t.id===job.ds_thread_id);if(!t)return;
    if(job.cancel_requested)result={...result,state:'cancelled'};
    job.state=result.state;job.finished_at=now();job.result=result.result||'';job.usage=result.usage||{};job.model_usage=result.modelUsage||{};
    this.save();this.observing.delete(id);
    const seq=job.ds_seq_base||0;
    if(result.result&&(!t.lastEventSeq||t.lastEventSeq<seq+1))this.engine.onEvent(t.sessionId,{seq:seq+1,type:'assistant/message',data:{message:{content:[{type:'text',text:result.result}]}}});
    if(result.state==='completed')this.collectArtifacts(t,job);
    if(t.kind!=='main'&&result.state==='completed'&&!t.outcome)this.engine.finish(t.sessionId,(result.result?.trim()||'Task completed.').slice(0,12000));
    if(!t.lastEventSeq||t.lastEventSeq<seq+2)this.engine.onEvent(t.sessionId,{seq:seq+2,type:'turn/end',data:{reason:{
      kind:result.state==='completed'?'completed':result.state==='cancelled'?'aborted':'error',message:result.error||'Local execution failed'}}});
    job.delivered=true;this.save();this.onTaskFinished(job.session_id);this.changed();
  }
  recover() {
    if(this.closed)return;
    const {threads,requests}=this.engine.store.data;
    for(const t of threads) {
      if(t.dispatchKey)requests[t.dispatchKey]={taskId:t.id};
      for(const m of t.messages)if(m.requestId)requests[`send:${t.id}:${m.requestId}`]={messageId:m.id};
      if(t.runningRequestId)requests[`send:${t.id}:${t.runningRequestId}`]={messageId:t.currentMessageId};
      const running=this.meta.jobs.find(j=>j.ds_thread_id===t.id&&j.state==='running');
      if(running&&this.runner){this.engine.active.add(t.id);t.status=this.meta.permissions.some(p=>p.job_id===running.id&&p.state==='pending')?'approval':'running';
        this.observing.add(running.id);this.runner.observe(running.directory,result=>queueMicrotask(()=>void this.deliver(running.id,result)));continue;}
      const finished=this.meta.jobs.findLast(j=>j.ds_thread_id===t.id&&!busy(j.state)&&!j.delivered);
      if(finished){this.engine.active.add(t.id);queueMicrotask(()=>void this.deliver(finished.id,{state:finished.state,result:finished.result,usage:finished.usage}));continue;}
      const queued=this.meta.jobs.find(j=>j.ds_thread_id===t.id&&j.state==='queued');
      if(queued&&!t.pending){t.pending={text:queued.input_text,messageId:t.messages.find(m=>m.requestId===queued.request_id)?.id,
        requestId:queued.request_id,source:queued.source_metadata||{kind:'user'},previousStatus:'ready'};t.status='queued';}
      else if(['running','approval'].includes(t.status)){t.status='interrupted';this.engine.active.delete(t.id);}
    }
    this.engine.store.save();if(this.runner)this.engine.pump();this.changed();
  }
  async stopSession(t) {for(const j of this.meta.jobs.filter(j=>j.ds_thread_id===t.id&&busy(j.state))){
    j.cancel_requested=true;if(j.state==='running')this.runner?.cancel(j.directory,j.tool_token);else{j.state='cancelled';j.delivered=true;}
    for(const p of this.meta.permissions)if(p.job_id===j.id&&p.state==='pending')p.state='denied';
  }this.save();this.changed();}
  async cancelThread(t){await this.stopSession(t);await this.engine.stop(t.id);}
  sessionUsage(id){const jobs=this.meta.jobs.filter(j=>j.session_id===id),known=jobs.filter(j=>j.usage&&(Number.isFinite(j.usage.input_tokens)||Number.isFinite(j.usage.output_tokens)));if(!known.length)return null;
    return known.reduce((n,j)=>({input:n.input+(j.usage.input_tokens||0),output:n.output+(j.usage.output_tokens||0),
      cacheRead:n.cacheRead+(j.usage.cache_read_input_tokens||0),cacheWrite:n.cacheWrite+(j.usage.cache_creation_input_tokens||0)}),{input:0,output:0,cacheRead:0,cacheWrite:0});}
  async usage(p){return usageView(this.engine,p.id);}
  channelDTO(p){return{id:channelId(p.id),name:p.name,topic:p.description,visibility:'private',created_at:p.createdAt,updated_at:p.updatedAt||p.createdAt,
    created_by_account_id:this.accountId,creator_account_id:this.accountId,members:[{account_id:this.accountId,role:'owner'}],member_count:1,
    context_sources:p.contextSources||[],default_source_urls:p.sourceUrls||[],system_prompt_addendum:p.instructions,
    default_environment_id:'env_claudemom_local',execution_backend:'ds-project-local',settings:this.config(p),
    ...(p.archived?{archived_at:p.archivedAt||p.createdAt}:{})};}
  threadDTO(t){const jobs=this.meta.jobs.filter(j=>j.ds_thread_id===t.id),last=jobs.at(-1);
    const state=t.status==='waiting'?'waiting':t.status==='resolved'?'resolved':t.status==='queued'?'queued':['running','approval'].includes(t.status)?'running':t.status==='failed'?'failed':
      t.status==='stopped'?'cancelled':last?.state==='completed'?'completed':t.status;
    return{id:messageId(t.id),channel_id:channelId(t.projectId),title:t.title,state,session_id:t.sessionId,created_at:t.createdAt,updated_at:t.updatedAt,
      working_directory:t.cwd,branch:t.worktree?.branch,base_commit:t.worktree?.baseCommit,worktree:t.worktree,
      last_result:t.messages.findLast(m=>m.role==='assistant')?.text||'',ds_status:t.status};}
  messageDTOs(p){const rows=[];
    for(const t of this.engine.store.data.threads.filter(t=>t.projectId===p.id)){
      const root=messageId(t.id),main=t.kind==='main',job=this.meta.jobs.findLast(j=>j.ds_thread_id===t.id);
      if(!main)rows.push({id:root,channel_id:channelId(p.id),body:t.brief,thread_root_id:root,in_timeline:true,display_name:t.title,
        created_at:t.createdAt,updated_at:t.updatedAt,author_account_id:this.accountId,reply_count:t.messages.filter(m=>m.role==='assistant').length,
        thread_status:t.status==='approval'||t.status==='waiting'?'needs_input':t.status==='running'?'working':t.status==='failed'?'failed':t.status==='resolved'?'resolved':'idle',
        thread_waits_on_live_prompt:t.status==='approval',thread_preview:t.outcome?.summary||'',attachments:[],attached_outputs:[]});
      for(const m of t.messages){if(!main&&m.text===t.brief&&m.role!=='assistant')continue;
        rows.push({id:messageId(m.id),channel_id:channelId(p.id),body:m.text,created_at:m.at,updated_at:m.at,in_timeline:main,
          ...(!main?{thread_root_id:root,in_reply_to_message_id:root}:{}),
          ...(m.role==='user'?{author_account_id:this.accountId}:m.role==='assistant'?{author_session_id:t.sessionId||job?.session_id||t.id}:
            {author_agent_id:'claudemom-local',server_notice:true}),attachments:[],attached_outputs:[]});
      }
    }
    return rows.sort((a,b)=>a.created_at.localeCompare(b.created_at)).map((row,i)=>({...row,seq:i+1}));
  }
  snapshot(){const projects=this.engine.store.data.projects;
    return{schema:2,implementation:{name:'DS Project',...sourcePins},channels:projects.map(p=>this.channelDTO(p)),
      threads:this.engine.store.data.threads.filter(t=>t.kind!=='main').map(t=>this.threadDTO(t)),
      messages:projects.flatMap(p=>this.messageDTOs(p)),jobs:structuredClone(this.meta.jobs),schedules:structuredClone(this.meta.schedules),permissions:structuredClone(this.meta.permissions),
      files:projects.flatMap(p=>this.files(p).filter(f=>!f.is_directory).map(f=>({...f,channel_id:channelId(p.id),content:fs.readFileSync(within(libraryRoot(p),f.path)).toString('base64')}))),
      memories:projects.flatMap(p=>this.memory(p).map(m=>({...m,channel_id:channelId(p.id)})))};
  }
  librarySnapshot(p){return this.files(p).filter(f=>!f.is_directory).map(f=>({path:f.path,content:fs.readFileSync(within(libraryRoot(p),f.path)).toString('base64')}));}
  files(p){const root=libraryRoot(p),rows=[];const walk=(dir,prefix='')=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.isSymbolicLink())continue;
      const name=prefix+entry.name,full=within(root,name),stat=fs.statSync(full);if(stat.isDirectory()){rows.push({path:name,is_directory:true,size_bytes:0});walk(full,name+'/');}
      else if(stat.isFile()){const file=p.files.find(f=>f.relativePath===name||f.name===name);rows.push({path:name,is_directory:false,size_bytes:stat.size,updated_at:stat.mtime.toISOString(),
        content_sha256:sha(fs.readFileSync(full)),file_id:file?.sourceFileId||externalFileId(file?.id||stableUUID(p.id+':'+name)),kind:file?.kind||'import',source:file?.source});}
    }};walk(root);return rows;}
  importFile(p,name,content,{overwrite=false,sourceFileId}={}) {
    name=relativeName(name);const bytes=Buffer.from(content,'base64');if(bytes.toString('base64')!==content||bytes.length>8*1024*1024)throw Error('Invalid Library content');
    const found=p.files.find(f=>(f.relativePath||f.name)===name);
    let file;if(found){if(!overwrite)return{path:name,error_reason:'already_exists'};
      const target=within(libraryRoot(p),name),temporary=target+'.'+crypto.randomUUID()+'.next';fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,target);file=found;file.size=bytes.length;delete file.content;
      if(!sourceFileId){delete file.sourceFileId;file.id=crypto.randomUUID();}
    }else file=importLibraryFile(this.engine.store,p,name,content);
    if(sourceFileId)file.sourceFileId=sourceFileId;this.engine.store.save();const entry=this.files(p).find(f=>f.path===name);return{path:name,content_sha256:entry.content_sha256,entry};
  }
  collectArtifacts(t,job) {
    if(t.kind==='main'||!t.worktree)return;
    const p=this.engine.store.project(t.projectId);for(const name of changedFiles(t.cwd))try{
      const file=within(t.cwd,name),stat=fs.statSync(file);if(!stat.isFile()||stat.size>8*1024*1024)continue;
      const target=`Artifacts/${messageId(t.id).slice(0,18)}/${job.id.slice(0,8)}/${name}`;
      let entry=p.files.find(f=>f.relativePath===target);if(!entry){this.importFile(p,target,fs.readFileSync(file).toString('base64'));entry=p.files.find(f=>f.relativePath===target);}
      Object.assign(entry,{kind:'output',source:{threadId:messageId(t.id),title:t.title,path:name,jobId:job.id}});
    }catch(error){(job.artifact_errors||=[]).push({path:name,error:error.message});}this.engine.store.save();
  }
  memory(p){return memoryFiles(p).map(f=>({id:memoryId(p.id,f.name),path:'/'+f.name,size_bytes:f.size,
    content:readMemory(p,f.name).content,content_sha256:sha(readMemory(p,f.name).content)}));}
  writeMemory(p,name,content,expected,create=false) {
    name=String(name).replace(/^\//,'');const existing=this.memory(p).find(m=>m.path==='/'+name);
    if(create&&existing)throw Error('Memory already exists');if(expected!==undefined&&existing?.content_sha256!==expected)throw Error('Memory changed; read its current version');
    saveMemory(this.engine.store,p,{name,content});return this.memory(p).find(m=>m.path==='/'+name);
  }
  close(){this.closed=true;this.runner?.close();}
  migrate(old) {
    if(!fs.existsSync(this.file+'.pre-ds-project'))fs.copyFileSync(this.file,this.file+'.pre-ds-project');
    const data=this.engine.store.data;
    for(const channel of old.channels||[]){const id=rawUUID(channel.id,'chan_');if(data.projects.some(p=>p.id===id&&p.bridgeMigrationComplete))continue;
      const mainId=stableUUID(channel.id+':coordinator'),cwd=path.join(this.engine.store.home,'workspaces',id);fs.mkdirSync(cwd,{recursive:true,mode:0o700});
      let p=data.projects.find(p=>p.id===id);if(!p){p={id,name:channel.name,description:channel.topic||'',instructions:channel.system_prompt_addendum||'',memories:[],files:[],reports:[],activities:[],createdAt:channel.created_at,
        archived:!!channel.archived_at,cwd,mainThreadId:mainId,channelConfig:channel.settings||{},contextSources:channel.context_sources||[]};data.projects.push(p);}
      if(!data.threads.some(t=>t.id===mainId))data.threads.push({id:mainId,projectId:id,title:'主对话',kind:'main',brief:'',status:'ready',messages:[],sessionId:null,createdAt:p.createdAt,updatedAt:p.createdAt,activity:'',pending:null});
      for(const item of old.threads?.filter(t=>t.channel_id===channel.id)||[])if(!data.threads.some(t=>messageId(t.id)===item.id))data.threads.push({id:rawUUID(item.id,'cmsg_'),projectId:id,title:item.title,kind:'execute',brief:old.messages.find(m=>m.id===item.id)?.body||'',status:'ready',messages:[],sessionId:null,createdAt:item.created_at,updatedAt:item.updated_at,activity:'',pending:null});
      for(const m of old.messages?.filter(m=>m.channel_id===channel.id)||[]){const t=m.thread_root_id?data.threads.find(t=>messageId(t.id)===m.thread_root_id):data.threads.find(t=>t.id===mainId);
        if(t&&!t.messages.some(item=>messageId(item.id)===m.id))t.messages.push({id:rawUUID(m.id,'cmsg_'),role:m.author_account_id?'user':m.server_notice?'event':'assistant',text:m.body,at:m.created_at,admitted:true,...m.client_message_id?{requestId:'user:'+m.client_message_id}:{}});}
      for(const f of old.files?.filter(f=>f.channel_id===channel.id)||[])this.importFile(p,f.path,f.content);
      for(const m of old.memories?.filter(m=>m.channel_id===channel.id)||[])this.writeMemory(p,m.path,m.content);
      p.bridgeMigrationComplete=true;this.engine.store.save();
    }
    for(const j of this.meta.jobs){j.ds_thread_id=j.thread_root_id?rawUUID(j.thread_root_id,'cmsg_'):stableUUID(j.channel_id+':coordinator');
      const input=old.messages?.find(m=>m.id===j.input_id);j.request_id=input?.client_message_id?'user:'+input.client_message_id:'legacy:'+j.id;j.input_text=input?.body||'Continue the interrupted local task.';
      if(!busy(j.state))j.delivered=true;
      if(j.state==='running'){const t=data.threads.find(t=>t.id===j.ds_thread_id);if(t){t.sessionId=j.session_id;t.cliSessionId=j.session_id;t.legacyActor=true;t.status='running';t.runningRequestId=j.request_id;
        if(j.directory)t.cwd=path.join(path.dirname(path.dirname(j.directory)),'workspaces',j.thread_root_id||'coordinator');}}
    }
    this.engine.store.save();
  }
}
