import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const privateJSON=(file,value)=>fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
export function createProjectRunner({directory,binary,baseUrl,clientKey,profileHome,onActiveChange=()=>{}}) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const active=new Map();let closed=false;
  const count=()=>onActiveChange(active.size);
  function environment(configDir,tmp) {
    // In particular, do not pass CI tokens, upstream credentials, personal CLI
    // settings, MCP configuration, or hooks to a model-controlled process.
    // Preserve the real HOME unchanged so shell startup works. Configuration
    // and transcripts use the explicit owned CLAUDE_CONFIG_DIR below.
    const env={};for(const name of ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TZ']) {
      if(process.env[name])env[name]=process.env[name];
    }
    return{...env,CFFIXED_USER_HOME:profileHome,CLAUDE_CONFIG_DIR:configDir,TMPDIR:tmp,
      ANTHROPIC_BASE_URL:typeof baseUrl==='function'?baseUrl():baseUrl,
      ANTHROPIC_API_KEY:clientKey,ANTHROPIC_AUTH_TOKEN:clientKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',CI:'1'};
  }
  function observe(jobDir,settle) {
    if(active.has(jobDir))throw Error('Local project job is already observed');
    let timer;
    const check=()=>{
      if(closed)return;
      let value;try{value=JSON.parse(fs.readFileSync(path.join(jobDir,'status.json')));}catch{return;}
      if(!['completed','failed','cancelled'].includes(value.state))return;
      clearInterval(timer);active.delete(jobDir);count();settle(value);
    };
    timer=setInterval(check,300);timer.unref();active.set(jobDir,timer);count();check();
  }
  function run({projectId,prompt,model,effort='low',sessionId=crypto.randomUUID(),resume=false,role='worker',
    lane='coordinator',jobId=crypto.randomUUID(),toolToken,library=[],onPrepared=()=>{},workspace}) {
    if(closed)throw Error('Project runner closed');
    if(!/^chan_[A-Za-z0-9_-]{1,120}$/.test(projectId)||typeof prompt!=='string'||prompt.length>200000)throw Error('Invalid local project job');
    if(typeof model!=='string'||!model||model.startsWith('-')||model.length>500)throw Error('Invalid project model');
    if(!['low','medium','high','max'].includes(effort))throw Error('Invalid local project effort');
    if(!/^[0-9a-f-]{36}$/i.test(sessionId))throw Error('Invalid project session');
    if(!/^(?:coordinator|cmsg_[A-Za-z0-9_-]{1,120})$/.test(lane)||!['worker','coordinator'].includes(role))throw Error('Invalid project lane');
    if(active.size>=4)throw Error('Local project concurrency limit reached');
    const id=jobId,project=path.join(directory,projectId),jobDir=path.join(project,'jobs',id);
    const cwd=workspace||path.join(project,'workspaces',lane),configDir=path.join(project,'cli',sessionId),tmp=path.join(jobDir,'tmp');
    for(const dir of [jobDir,cwd,configDir,tmp])fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const libraryHash=crypto.createHash('sha256').update(JSON.stringify(library)).digest('hex').slice(0,20);
    const libraryRoot=path.join(cwd,'.claudemom-library',libraryHash);
    for(const file of library) {
      if(typeof file.path!=='string'||!file.path||file.path.split('/').some(p=>!p||p==='.'||p==='..')||/[\\\x00-\x1f]/.test(file.path))throw Error('Invalid Library path');
      const target=path.join(libraryRoot,file.path);
      let parent=cwd;
      for(const part of path.relative(cwd,path.dirname(target)).split(path.sep)) {
        parent=path.join(parent,part);
        if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('Library directory became a symlink');
        fs.mkdirSync(parent,{recursive:true,mode:0o700});
      }
      if(fs.existsSync(target)){if(!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink())throw Error('Invalid Library file');}
      else fs.writeFileSync(target,Buffer.from(file.content,'base64'),{flag:'wx',mode:0o400});
    }
    const api=typeof baseUrl==='function'?baseUrl():baseUrl;
    privateJSON(path.join(jobDir,'mcp.json'),{mcpServers:toolToken?{local_project:{command:process.execPath,
      args:[path.join(here,'projects-mcp.mjs')],env:{LOCAL_PROJECT_ORIGIN:api,LOCAL_PROJECT_TOKEN:toolToken,LOCAL_PROJECT_JOB:id,LOCAL_PROJECT_ROLE:role}}}:{}});
    const args=['--print','--verbose','--output-format','json','--model',model,'--effort',effort,
      ...(resume?['--resume',sessionId]:['--session-id',sessionId]),
      '--setting-sources','','--strict-mcp-config','--mcp-config',path.join(jobDir,'mcp.json'),
      '--tools',role==='coordinator'?'':'Bash,Read,Write,Edit,Glob,Grep',
      '--permission-mode','default',
      ...(toolToken?['--permission-prompt-tool','mcp__local_project__approve','--allowedTools',
        'mcp__local_project__start_thread_session,mcp__local_project__list_thread_sessions,mcp__local_project__send_message,mcp__local_project__fetch_messages,mcp__local_project__list_project_files,mcp__local_project__read_project_file,mcp__local_project__read_memory,mcp__local_project__write_memory,mcp__local_project__create_schedule,mcp__local_project__list_schedules,mcp__local_project__project_launch_task,mcp__local_project__project_list_threads,mcp__local_project__project_send_to_thread,mcp__local_project__project_update_thread,mcp__local_project__project_read_context,mcp__local_project__project_read_activity,mcp__local_project__project_search_history,mcp__local_project__project_remember,mcp__local_project__project_forget,mcp__local_project__project_memory_file,mcp__local_project__project_finish_task,mcp__local_project__project_publish_file']:[]),
      '--settings',JSON.stringify({sandbox:{enabled:false}})];
    privateJSON(path.join(jobDir,'status.json'),{schema:1,id,sessionId,state:'starting',createdAt:new Date().toISOString()});
    privateJSON(path.join(jobDir,'launch.json'),{id,sessionId,binary,args,prompt:prompt+`\n\nProject Library snapshot: ${libraryRoot}`,cwd,
      controlToken:toolToken||crypto.randomBytes(24).toString('hex'),env:{...environment(configDir,tmp),MCP_TOOL_TIMEOUT:'86400000'}});
    // The controller journals ownership before any external tool can execute.
    onPrepared({id,sessionId,directory:jobDir,workspace:cwd});
    const host=spawn(process.execPath,[path.join(here,'projects-job.mjs'),jobDir],{
      detached:true,env:{PATH:process.env.PATH||'/usr/bin:/bin'},stdio:'ignore'});
    host.once('error',()=>privateJSON(path.join(jobDir,'status.json'),{schema:1,id,sessionId,state:'failed',code:-1,result:''}));
    host.unref();
    const done=new Promise(resolve=>observe(jobDir,resolve));
    return{id,sessionId,directory:jobDir,workspace:cwd,done};
  }
  return{run,observe,cancel(jobDir,token){privateJSON(path.join(jobDir,'cancel.json'),{token});},active:()=>active.size,
    close(){closed=true;for(const timer of active.values())clearInterval(timer);active.clear();}};
}
