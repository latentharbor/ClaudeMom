// MCP is a separate process, so an outstanding permission request survives
// frontend reloads and compatibility-core replacement. No upstream key is used.
import readline from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

const origin=process.env.LOCAL_PROJECT_ORIGIN,token=process.env.LOCAL_PROJECT_TOKEN,job=process.env.LOCAL_PROJECT_JOB;
const tools=[
  {name:'approve',description:'Host permission prompt. Not a model tool.',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'}},required:['tool_name','input']}},
  {name:'start_thread_session',description:'Start an independent local worker thread. Threads can run in parallel and have separate working directories.',inputSchema:{type:'object',properties:{title:{type:'string'},prompt:{type:'string'}},required:['title','prompt']}},
  {name:'list_thread_sessions',description:'Read local project thread status and latest replies.',inputSchema:{type:'object',properties:{}}},
  {name:'send_message',description:'Send a follow-up to a local worker thread.',inputSchema:{type:'object',properties:{thread_id:{type:'string'},body:{type:'string'}},required:['thread_id','body']}},
  {name:'fetch_messages',description:'Read the current project or one thread.',inputSchema:{type:'object',properties:{thread_id:{type:'string'}}}},
  {name:'list_project_files',description:'List project Library files.',inputSchema:{type:'object',properties:{}}},
  {name:'read_project_file',description:'Read a text Library file or a bounded range.',inputSchema:{type:'object',properties:{path:{type:'string'},offset:{type:'integer'},length:{type:'integer'}},required:['path']}},
  {name:'read_memory',description:'Read shared project memory.',inputSchema:{type:'object',properties:{path:{type:'string'}}}},
  {name:'write_memory',description:'Write shared memory with a version precondition. Read the previous hash before overwriting.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'},expected_sha256:{type:'string'}},required:['path','content']}},
  {name:'create_schedule',description:'Schedule a local worker task using a one-time ISO date or five-field cron with an IANA timezone. Tool permissions still require user approval.',inputSchema:{type:'object',properties:{name:{type:'string'},prompt:{type:'string'},cron_expression:{type:'string'},run_once_at:{type:'string'},timezone:{type:'string'}},required:['name','prompt']}},
  {name:'list_schedules',description:'List local project schedules.',inputSchema:{type:'object',properties:{}}},
];
async function call(name,input,requestId) {
  const route=`${origin}/__codex_plus/projects-lab/jobs/${job}/tools`;
  let response;
  for(let attempt=0;attempt<60;attempt++) {
    try{response=await fetch(route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({name,input,request_id:String(requestId)}),signal:AbortSignal.timeout(15000)});break;}
    catch{await delay(1000);}
  }
  if(!response)throw Error('Local project service is unavailable');
  const value=await response.json();if(!response.ok)throw Error(value.error?.message||'Local project tool failed');
  if(name!=='approve')return value;
  for(let n=0;n<86400;n++) {
    await delay(500);
    try{
      const answer=await fetch(`${route}/${value.id}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if(answer.status===410)return{behavior:'deny',message:'The local task or permission request has ended.'};
      if(!answer.ok)continue;
      const decision=await answer.json();
      if(decision.state==='allowed')return{behavior:'allow'};
      if(decision.state==='denied')return{behavior:'deny',message:'The user denied this operation.'};
    }catch{}
  }
  return{behavior:'deny',message:'The local permission request expired.'};
}
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  void(async()=>{
    let request;try{request=JSON.parse(line);}catch{return;}
    if(request.id===undefined)return;
    try{
      let result;
      if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'claudemom-local-project',version:'1'}};
      else if(request.method==='ping')result={};
      else if(request.method==='tools/list')result={tools:process.env.LOCAL_PROJECT_ROLE==='coordinator'?tools:tools.filter(t=>!['start_thread_session','send_message','create_schedule'].includes(t.name))};
      else if(request.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(await call(request.params.name,request.params.arguments||{},request.id))}]};
      else throw Error('Unknown local MCP method');
      send({jsonrpc:'2.0',id:request.id,result});
    }catch(error){send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}});}
  })();
});
