// Owned local job host. It outlives Desktop and the compatibility core. Only the
// isolated Projects lab launches this file; there is no production enablement.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory=process.argv[2];
const configFile=path.join(directory,'launch.json');
const config=JSON.parse(fs.readFileSync(configFile));
fs.unlinkSync(configFile); // Do not leave the local gateway key in job history.
const record=values=>{
  const tmp=path.join(directory,'status.next');
  fs.writeFileSync(tmp,JSON.stringify({schema:1,id:config.id,sessionId:config.sessionId,...values}),{mode:0o600});
  fs.renameSync(tmp,path.join(directory,'status.json'));
};
let output='',errors='',finished=false,cancelled=false;
function finish(values) {
  if(finished)return;finished=true;
  clearInterval(cancellation);
  let answer;
  for(const line of output.split('\n')) {
    try{const value=JSON.parse(line);if(value.type==='result')answer=value;}catch{}
  }
  if(!answer)try{const value=JSON.parse(output);answer=(Array.isArray(value)?value:[value]).findLast(v=>v?.type==='result');}catch{}
  fs.writeFileSync(path.join(directory,'stdout.log'),output,{mode:0o600});
  fs.writeFileSync(path.join(directory,'stderr.log'),errors,{mode:0o600});
  record({state:cancelled?'cancelled':values.code===0&&answer&&answer.is_error!==true?'completed':'failed',finishedAt:new Date().toISOString(),
    result:typeof answer?.result==='string'?answer.result.slice(0,100000):'',
    usage:answer?.usage||{},...values,
    // Error text stays in the private job folder, never in a public health API.
    error:values.code===0?undefined:errors.slice(-4000)});
}
const cli=spawn(config.binary,config.args,{cwd:config.cwd,env:config.env,detached:true,stdio:['pipe','pipe','pipe']});
const cancellation=setInterval(()=>{
  if(finished||cancelled)return;
  try{if(JSON.parse(fs.readFileSync(path.join(directory,'cancel.json'))).token!==config.controlToken)return;}catch{return;}
  cancelled=true;
  try{process.kill(-cli.pid,'SIGTERM');}catch{}
  setTimeout(()=>{if(!finished)try{process.kill(-cli.pid,'SIGKILL');}catch{}},5000).unref();
},300);
record({state:'running',startedAt:new Date().toISOString(),hostPid:process.pid,pid:cli.pid});
cli.once('error',()=>finish({code:-1}));
cli.stdout.on('data',part=>{
  if(Buffer.byteLength(output)<=16*1024*1024)output+=part;
  if(Buffer.byteLength(output)>16*1024*1024){errors='Local job output limit reached';cli.kill('SIGTERM');}
});
cli.stderr.on('data',part=>{errors=(errors+part).slice(-32000);});
cli.once('close',(code,signal)=>finish({code:code??-1,signal}));
cli.stdin.on('error',()=>{});
cli.stdin.end(config.prompt);
