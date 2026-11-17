// MCP is a separate process, so an outstanding permission request survives
// frontend reloads and compatibility-core replacement. No upstream key is used.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {coordinatorTools} from './third-party/ds-project/coordinator.js';

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
  {name:'project_launch_task',description:'DS Project: dispatch an independent worktree task and return without waiting.',inputSchema:{type:'object',properties:{title:{type:'string'},brief:{type:'string'},kind:{type:'string',enum:['research','execute']}},required:['title','brief']}},
  {name:'project_list_threads',description:'DS Project: inspect thread status and latest results.',inputSchema:{type:'object',properties:{}}},
  {name:'project_send_to_thread',description:'DS Project: continue an existing task.',inputSchema:{type:'object',properties:{thread_id:{type:'string'},body:{type:'string'}},required:['thread_id','body']}},
  {name:'project_update_thread',description:'DS Project: stop, resolve or reopen a task.',inputSchema:{type:'object',properties:{thread_id:{type:'string'},action:{type:'string',enum:['stop','resolve','reopen']}},required:['thread_id','action']}},
  {name:'project_read_context',description:'DS Project: read project memory, Library and paginated task history.',inputSchema:{type:'object',properties:{query:{type:'string'},file_id:{type:'string'},task_id:{type:'string'},before_message_id:{type:'string'},limit:{type:'integer'}}}},
  {name:'project_read_activity',description:'DS Project: read bounded activity after a cursor.',inputSchema:{type:'object',properties:{after:{type:'integer'},limit:{type:'integer'}}}},
  {name:'project_search_history',description:'DS Project: search preserved project history.',inputSchema:{type:'object',properties:{query:{type:'string'},thread_id:{type:'string'},limit:{type:'integer'}},required:['query']}},
  {name:'project_remember',description:'DS Project: remember an established preference or decision in MEMORY.md.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
  {name:'project_forget',description:'DS Project: forget an obsolete project memory.',inputSchema:{type:'object',properties:{id:{type:'string'},expected_revision:{type:'integer'}},required:['id']}},
  {name:'project_memory_file',description:'DS Project: list/read/write project memory files; read the SHA before editing.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','read','write','delete']},name:{type:'string'},content:{type:'string'},expected_sha256:{type:'string'}}}},
  {name:'project_finish_task',description:'DS Project: report a task result, whether it needs user input, and whether it is resolved.',inputSchema:{type:'object',properties:{summary:{type:'string'},needs_input:{type:'boolean'},resolved:{type:'boolean'}},required:['summary']}},
  {name:'project_publish_file',description:'DS Project: publish a real worktree file into the project Library.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}},
];
async function call(name,input,requestId) {
  if(name==='project_publish_file'){
    // Read model-selected files here, inside the inherited OS Sandbox. Sending
    // bytes avoids a privileged host read and symlink-race export bypass.
    const root=fs.realpathSync(process.env.LOCAL_PROJECT_WORKSPACE),file=fs.realpathSync(path.resolve(root,String(input.path||'')));
    if(!file.startsWith(root+path.sep))throw Error('The output must belong to this task worktree');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>500000)throw Error('Publish a regular text file of up to 500 KB, without hard links');
      const bytes=fs.readFileSync(fd);if(bytes.includes(0))throw Error('Publish a text file');input={path:path.relative(root,file),content:bytes.toString('base64')};}
    finally{fs.closeSync(fd);}
  }
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
const coordinatorCatalog=new Set([...coordinatorTools,'approve','start_thread_session','list_thread_sessions','send_message','fetch_messages','list_project_files','read_project_file','read_memory','write_memory','create_schedule','list_schedules']);
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  void(async()=>{
    let request;try{request=JSON.parse(line);}catch{return;}
    if(request.id===undefined)return;
    try{
      let result;
      if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'claudemom-local-project',version:'1'}};
      else if(request.method==='ping')result={};
      else if(request.method==='tools/list')result={tools:process.env.LOCAL_PROJECT_ROLE==='coordinator'?tools.filter(t=>coordinatorCatalog.has(t.name)):tools.filter(t=>!['start_thread_session','send_message','create_schedule'].includes(t.name))};
      else if(request.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(await call(request.params.name,request.params.arguments||{},request.id))}]};
      else throw Error('Unknown local MCP method');
      send({jsonrpc:'2.0',id:request.id,result});
    }catch(error){send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}});}
  })();
});
