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
      if(!['completed','failed'].includes(value.state))return;
      clearInterval(timer);active.delete(jobDir);count();settle(value);
    };
    timer=setInterval(check,300);timer.unref();active.set(jobDir,timer);count();check();
  }
  function run({projectId,prompt,model,sessionId=crypto.randomUUID(),resume=false}) {
    if(closed)throw Error('Project runner closed');
    if(!/^chan_[A-Za-z0-9_-]{1,120}$/.test(projectId)||typeof prompt!=='string'||prompt.length>200000)throw Error('Invalid local project job');
    if(typeof model!=='string'||!model||model.startsWith('-')||model.length>500)throw Error('Invalid project model');
    if(!/^[0-9a-f-]{36}$/i.test(sessionId))throw Error('Invalid project session');
    if(active.size>=4)throw Error('Local project concurrency limit reached');
    const id=crypto.randomUUID(),project=path.join(directory,projectId),jobDir=path.join(project,'jobs',id);
    const cwd=path.join(project,'workspace'),configDir=path.join(project,'cli'),tmp=path.join(jobDir,'tmp');
    for(const dir of [jobDir,cwd,configDir,tmp])fs.mkdirSync(dir,{recursive:true,mode:0o700});
    privateJSON(path.join(jobDir,'mcp.json'),{mcpServers:{}});
    const args=['--print','--verbose','--output-format','json','--model',model,
      ...(resume?['--resume',sessionId]:['--session-id',sessionId]),
      '--setting-sources','','--strict-mcp-config','--mcp-config',path.join(jobDir,'mcp.json'),
      '--tools','Bash,Read,Write,Edit,Glob,Grep,Agent',
      // Lab only: the owned fake model test uses a fixed write in this owned
      // workspace. Production needs an interactive consent/sandbox bridge.
      '--dangerously-skip-permissions','--settings',JSON.stringify({sandbox:{enabled:false}})];
    privateJSON(path.join(jobDir,'status.json'),{schema:1,id,sessionId,state:'starting',createdAt:new Date().toISOString()});
    privateJSON(path.join(jobDir,'launch.json'),{id,sessionId,binary,args,prompt,cwd,env:environment(configDir,tmp)});
    const host=spawn(process.execPath,[path.join(here,'projects-job.mjs'),jobDir],{
      detached:true,env:{PATH:process.env.PATH||'/usr/bin:/bin'},stdio:'ignore'});
    host.once('error',()=>privateJSON(path.join(jobDir,'status.json'),{schema:1,id,sessionId,state:'failed',code:-1,result:''}));
    host.unref();
    const done=new Promise(resolve=>observe(jobDir,resolve));
    return{id,sessionId,directory:jobDir,workspace:cwd,done};
  }
  return{run,observe,active:()=>active.size,close(){closed=true;for(const timer of active.values())clearInterval(timer);active.clear();}};
}
