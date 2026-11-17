// Trusted job controller and narrowly scoped broker. Only its CLI child and
// descendants execute model actions, inside the required outer OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createProjectBroker} from './projects-broker.mjs';
import {projectSandbox,sandboxCommand} from './projects-sandbox.mjs';

const directory=process.argv[2],file=path.join(directory,'launch.json');
const config=JSON.parse(fs.readFileSync(file));fs.unlinkSync(file);
const sandbox={required:true,version:1,backend:'macos-seatbelt',enforced:false};
let output='',errors='',finished=false,cancelled=false,cli,broker,sockets,cancellation,plan,profileFile;
const record=values=>{
  const tmp=path.join(directory,'status.next');
  fs.writeFileSync(tmp,JSON.stringify({schema:1,id:config.id,sessionId:config.sessionId,sandbox,...values}),{mode:0o600});
  fs.renameSync(tmp,path.join(directory,'status.json'));
};
async function finish(values) {
  if(finished)return;finished=true;clearInterval(cancellation);
  let answer;
  for(const line of output.split('\n'))try{const value=JSON.parse(line);if(value.type==='result')answer=value;}catch{}
  if(!answer)try{const value=JSON.parse(output);answer=(Array.isArray(value)?value:[value]).findLast(v=>v?.type==='result');}catch{}
  fs.writeFileSync(path.join(directory,'stdout.log'),output,{mode:0o600});
  fs.writeFileSync(path.join(directory,'stderr.log'),errors,{mode:0o600});
  await broker?.close();let artifacts=[],artifactErrors=[];
  if(!cancelled&&values.code===0&&answer?.is_error!==true&&config.role==='worker')try{
    const command=sandboxCommand(plan,profileFile,config.nodeBinary,[path.join(config.runtimeDir,'projects-artifacts.mjs'),config.cwd]);
    const captured=spawnSync(command.command,command.args,{cwd:config.cwd,env:config.env,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
    if(captured.status!==0)throw Error('Sandboxed artifact capture failed');
    const result=JSON.parse(captured.stdout);artifacts=result.files;artifactErrors=result.errors;
  }catch{values={...values,code:-1,error_code:'project_artifact_capture_failed',error:'Outputs could not be captured inside the required Sandbox; no privileged read was attempted.'};}
  if(sockets)fs.rmSync(sockets,{recursive:true,force:true});
  record({state:cancelled?'cancelled':values.code===0&&answer&&answer.is_error!==true?'completed':'failed',finishedAt:new Date().toISOString(),
    result:typeof answer?.result==='string'?answer.result.slice(0,100000):'',usage:answer?.usage||{},modelUsage:answer?.modelUsage||{},artifacts,artifact_errors:artifactErrors,...values,
    error:values.error||(values.code===0?undefined:'The sandboxed CLI stopped; see the private task log. No unsandboxed retry was started.')});
}
try{
  broker=await createProjectBroker({upstream:config.upstream,clientKey:config.clientKey,toolToken:config.toolToken,
    jobId:config.id,model:config.args[config.args.indexOf('--model')+1],...config.routing,sessionId:config.sessionId});
  sockets=fs.mkdtempSync('/private/tmp/cm-project-');fs.chmodSync(sockets,0o700);
  const mcpFile=path.join(directory,'mcp.json');
  fs.writeFileSync(mcpFile,JSON.stringify({mcpServers:{local_project:{command:config.nodeBinary,args:[path.join(config.runtimeDir,'projects-mcp.mjs')],
    env:{LOCAL_PROJECT_ORIGIN:broker.origin,LOCAL_PROJECT_TOKEN:config.toolToken,LOCAL_PROJECT_JOB:config.id,LOCAL_PROJECT_ROLE:config.role,LOCAL_PROJECT_WORKSPACE:config.cwd}}}}),{mode:0o600});
  plan=projectSandbox({workspace:config.cwd,configDir:config.env.CLAUDE_CONFIG_DIR,tmp:config.env.TMPDIR,sockets,binary:config.binary,
    nodeBinary:config.nodeBinary,runtimeDir:config.runtimeDir,mcpFile,port:broker.port});
  profileFile=path.join(directory,'sandbox.sb');fs.writeFileSync(profileFile,plan.profile,{mode:0o600});
  const command=sandboxCommand(plan,profileFile,config.binary,['--messaging-socket-path',path.join(sockets,'agent.sock'),...config.args]);
  const env={...config.env,ANTHROPIC_BASE_URL:broker.origin,ANTHROPIC_API_KEY:config.toolToken,ANTHROPIC_AUTH_TOKEN:config.toolToken,
    HTTP_PROXY:broker.proxyURL,HTTPS_PROXY:broker.proxyURL,http_proxy:broker.proxyURL,https_proxy:broker.proxyURL,NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1'};
  cli=spawn(command.command,command.args,{cwd:config.cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  sandbox.enforced=true;
  cancellation=setInterval(()=>{
    if(finished||cancelled)return;
    try{if(JSON.parse(fs.readFileSync(path.join(directory,'cancel.json'))).token!==config.controlToken)return;}catch{return;}
    cancelled=true;try{process.kill(-cli.pid,'SIGTERM');}catch{}
    setTimeout(()=>{if(!finished)try{process.kill(-cli.pid,'SIGKILL');}catch{}},5000).unref();
  },300);
  record({state:'running',startedAt:new Date().toISOString(),hostPid:process.pid,pid:cli.pid});
  cli.once('error',()=>void finish({code:-1,error_code:'project_sandbox_launch_failed',error:'The required Sandbox process could not be launched; execution was blocked.'}));
  cli.stdout.on('data',part=>{if(Buffer.byteLength(output)<=16*1024*1024)output+=part;
    if(Buffer.byteLength(output)>16*1024*1024){errors='Project task output limit reached';try{process.kill(-cli.pid,'SIGTERM');}catch{}}});
  cli.stderr.on('data',part=>{errors=(errors+part).slice(-32000);});
  cli.once('close',(code,signal)=>void finish({code:code??-1,signal}));
  cli.stdin.on('error',()=>{});cli.stdin.end(config.prompt);
}catch(error){
  errors=String(error.diagnostic||error.message);await finish({code:-1,error_code:error.code||'project_sandbox_start_failed',
    error:'The required process Sandbox could not start; execution was blocked. Check the private task log.'});
}
