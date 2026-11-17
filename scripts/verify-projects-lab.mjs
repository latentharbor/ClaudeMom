import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyProjectsLab({frames,evaluate,clickText,until,result,root,output,rpc}) {
  const seen=[];
  async function frontend() {
    for(const frame of await frames()) {
      if(!frame.url.startsWith('https://claude.ai/'))continue;
      try {if(await evaluate(frame,"!!window['claude.web']&&document.readyState==='complete'"))return frame;}catch{}
    }
    return null;
  }
  await until(()=>clickText('Code'));
  await delay(2500);
  const frame=await until(frontend);
  // Navigate via the web router's /code entry. Desktop may translate it back
  // to /epitaxy; both the route and its Projects capabilities must be present.
  await evaluate(frame,"(()=>{history.pushState({},'','/code/projects/browse');dispatchEvent(new PopStateEvent('popstate'));return true;})()");
  await delay(7000);
  async function inspect() {
    const frame=await frontend();if(!frame)return null;
    const state=await evaluate(frame,"({url:location.href,text:document.body.innerText.slice(0,12000),buttons:[...document.querySelectorAll('button,a')].map(e=>({text:e.textContent.trim().slice(0,100),label:e.getAttribute('aria-label')}))})");
    seen.push(state);return{frame,state};
  }
  let current=await inspect();
  assert.ok(current,'Owned Projects frontend loaded');
  result.projects={route:current.state.url,initial:current.state};
  const opened=await until(async()=>{
    const current=await frontend();if(!current)return false;
    return evaluate(current,"(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>/^(New project|Create project|新建项目|创建项目)$/i.test(e.textContent.replace(/[\\uE000-\\uF8FF]/g,'').trim()));if(!e)return false;e.click();return true;})()");
  },30000);
  assert.equal(opened,true);
  await delay(2000);current=await inspect();result.projects.dialog=current.state;
  const filled=await evaluate(current.frame,"(()=>{const dialog=document.querySelector('[role=dialog]')||document;const e=[...dialog.querySelectorAll('input')].find(e=>e.type!=='hidden'&&e.getBoundingClientRect().width>20);if(!e)return false;e.focus();e.select();return true;})()");
  assert.equal(filled,true,'Project name field');
  await rpc('/insert-text',{id:current.frame.id,text:'LOCAL_PROJECTS_CI'});
  await delay(500);
  result.projects.filledForm=await evaluate(current.frame,"({inputs:[...document.querySelectorAll('input')].map(e=>({value:e.value,type:e.type})),buttons:[...document.querySelectorAll('[role=dialog] button')].map(e=>({text:e.textContent,disabled:e.disabled}))})");
  assert.equal(await evaluate(current.frame,"(()=>{const dialog=document.querySelector('[role=dialog]')||document;const e=[...dialog.querySelectorAll('button')].find(e=>!e.disabled&&/^(Create|Create project|New project|创建|创建项目|新建项目)$/i.test(e.textContent.replace(/[\\uE000-\\uF8FF]/g,'').trim()));if(!e)return false;e.click();return true;})()"),true);
  const saved=await until(async()=>{try{const frame=await frontend();const s=await evaluate(frame,"fetch('/v1/code/channels').then(r=>r.json()).then(r=>({channels:r.data}))");return s.channels.some(c=>c.name==='LOCAL_PROJECTS_CI')?s:null;}catch{return null;}});
  assert.equal(saved.channels.length,1);
  result.projects.createdId=saved.channels[0].id;
  result.checks.nativeProjectCreatedInLocalStore=true;
  await delay(2000);result.projects.created=(await inspect()).state;
  const project=saved.channels[0].id;
  const savedState=async()=>evaluate(await frontend(),`fetch('/v1/code/channels/${project}/local').then(r=>r.json())`);
  const nativeUpload=await evaluate(await frontend(),`(async()=>{
    const form=new FormData();form.set('file',new File(['NATIVE_LIBRARY_PROTOCOL'],'native-reference.txt',{type:'text/plain'}));
    const uploaded=await fetch('/api/ui-lab-org/upload?store_as_is=true',{method:'POST',body:form}).then(r=>r.json());
    const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+uploaded.file_uuid.replaceAll('-','')),value='';
    while(n){value=alphabet[Number(n%58n)]+value;n/=58n;}const id='file_01'+value.padStart(22,'1');
    const result=await fetch('/v1/code/channels/${project}/files:write',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({files:[{path:'native-reference.txt',source_file_id:id}]})}).then(r=>r.json());
    const read=await fetch('/v1/code/channels/${project}/attachments/'+id+'/content').then(r=>r.json());
    return{linked:!!result.results?.[0]?.entry,content:atob(read.data)};
  })()`);
  assert.equal(nativeUpload.linked,true);assert.equal(nativeUpload.content,'NATIVE_LIBRARY_PROTOCOL');
  result.checks.officialLibraryUploadContractInDesktop=true;
  assert.equal((await savedState()).implementation.name,'DS Project');result.checks.dsProjectCoreActive=true;
  const sent=await evaluate(await frontend(),`fetch('/v1/code/channels/${project}/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'UI_LAB_LOCAL_PROJECT_COORDINATOR',client_message_id:'cmsg_local_coordinator_fixture'})}).then(async r=>({status:r.status,body:await r.json()}))`);
  result.projects.send=sent;
  assert.equal(sent.status,200,'Local Projects must have a real execution backend');
  const reply=await until(async()=>{
    const state=await savedState();
    return state.messages.find(m=>m.author_session_id&&m.body.includes('UI_LAB_ROUTING_OK'));
  },60000);
  result.checks.localCoordinatorCompleted=true;
  const beforeReload=await frontend();
  try{await evaluate(beforeReload,'location.reload();true');}catch{}
  await delay(5000);
  const rendered=await until(async()=>{
    const frame=await frontend();return frame&&await evaluate(frame,"document.body.innerText.includes('UI_LAB_ROUTING_OK')");
  },30000);
  assert.equal(rendered,true,'Stored local reply appears in the official Projects timeline after reload');
  result.checks.localProjectReplySurvivesFrontendReload=true;
  result.projects.replyId=reply.id;
  result.projects.reloaded=(await inspect()).state;
  async function local(expression) {
    const frame=await frontend();if(!frame)return null;
    return evaluate(frame,`(()=>{const root=document.querySelector('#claudemom-local-projects')?.shadowRoot;if(!root)return null;return (${expression});})()`);
  }
  async function clickLocal(label,sectionText) {
    return until(()=>local(`(()=>{const scope=${sectionText?`[...root.querySelectorAll('section')].find(e=>e.textContent.includes(${JSON.stringify(sectionText)}))`:'root'};
      const button=[...(scope?.querySelectorAll('button')||[])].find(e=>e.textContent===${JSON.stringify(label)}&&!e.disabled);if(!button)return false;button.click();return true;})()`));
  }
  async function submitLocal(formName,values) {
    assert.equal(await local(`(()=>{const form=root.querySelector('[data-form=${formName}]');if(!form)return false;
      for(const [name,value]of Object.entries(${JSON.stringify(values)})){const e=form.elements.namedItem(name);if(!e)return false;e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}
      form.requestSubmit();return true;})()`),true);
  }
  await until(()=>local("!!root.querySelector('[data-toggle]')"));
  await local("(()=>{root.querySelector('[data-toggle]').click();return true;})()");
  const panelBackground=await local("getComputedStyle(root.querySelector('[data-panel]')).backgroundColor");
  assert.ok(!['transparent','rgba(0, 0, 0, 0)'].includes(panelBackground),'Local approval panel is opaque');
  await clickLocal('Library');
  await submitLocal('file',{path:'ui-library.md',content:'UI_LIBRARY_REFERENCE'});
  await until(async()=>(await savedState()).files.some(f=>f.path==='ui-library.md'));
  await clickLocal('重命名','ui-library.md');
  await submitLocal('rename',{path:'reference/renamed.md'});
  await until(async()=>(await savedState()).files.some(f=>f.path==='reference/renamed.md'));
  result.checks.libraryUiCreateAndRename=true;
  await clickLocal('线程');
  await submitLocal('thread',{title:'UI_APPROVAL_THREAD',prompt:'UI_PROJECT_TOOL'});
  const thread=await until(async()=>(await savedState()).threads.find(t=>t.title==='UI_APPROVAL_THREAD'));
  const pending=await until(async()=>(await savedState()).permissions.find(p=>p.thread_id===thread.id&&p.state==='pending'),60000);
  assert.equal((await savedState()).messages.find(m=>m.id===thread.id).thread_status,'needs_input');
  await clickLocal('权限确认');
  await until(()=>local("root.querySelector('[data-content]').textContent.includes('ui-project-approved.txt')"));
  assert.equal(await local("root.querySelector('[data-tab][aria-selected=true]').dataset.tab"),'permissions');
  await delay(200);
  const approvalFrame=await frontend();await rpc('/screenshot',{id:approvalFrame.id,name:'projects-permission.png'});
  fs.copyFileSync(path.join(root,'projects-permission.png'),path.join(output,'projects-permission.png'));
  await clickLocal('仅允许这次');
  await until(async()=>(await savedState()).jobs.some(j=>j.thread_root_id===thread.id&&j.state==='completed'),60000);
  const job=(await savedState()).jobs.find(j=>j.thread_root_id===thread.id);
  const workingDirectory=(await savedState()).threads.find(t=>t.id===thread.id).working_directory;
  assert.ok(fs.statSync(path.join(workingDirectory,'.git')).isFile());result.checks.nativeUiWorkerUsesWorktree=true;
  assert.equal(fs.readFileSync(path.join(workingDirectory,'ui-project-approved.txt'),'utf8'),'UI_PROJECT_APPROVED');
  assert.equal((await savedState()).permissions.find(p=>p.id===pending.id).state,'allowed');
  result.checks.nativeUiPermissionApprovedRealTool=true;
  await clickLocal('计划任务');
  await submitLocal('schedule',{name:'UI_ONCE_PLAN',prompt:'UI_PROJECT_SCHEDULE',kind:'once',run_once_at:new Date(Date.now()+3000).toISOString(),timezone:'Australia/Perth'});
  const schedule=await until(async()=>(await savedState()).schedules.find(s=>s.name==='UI_ONCE_PLAN'));
  await until(async()=>{const state=await savedState();return state.jobs.some(j=>j.source==='schedule'&&j.thread_root_id===state.schedules.find(s=>s.id===schedule.id).last_thread_id&&j.state==='completed');},60000);
  assert.equal((await savedState()).schedules.find(s=>s.id===schedule.id).enabled,false);
  result.checks.nativeUiOneTimeScheduleExecuted=true;
  await submitLocal('schedule',{name:'UI_CRON_PLAN',prompt:'Future daily task',kind:'cron',cron_expression:'0 9 * * *',timezone:'Australia/Perth'});
  const cron=await until(async()=>(await savedState()).schedules.find(s=>s.name==='UI_CRON_PLAN'));
  await clickLocal('暂停','UI_CRON_PLAN');await until(async()=>(await savedState()).schedules.find(s=>s.id===cron.id).enabled===false);
  await clickLocal('启用','UI_CRON_PLAN');await until(async()=>(await savedState()).schedules.find(s=>s.id===cron.id).enabled===true);
  await clickLocal('删除','UI_CRON_PLAN');await until(async()=>!(await savedState()).schedules.some(s=>s.id===cron.id));
  result.checks.nativeUiSchedulePauseResumeDelete=true;
  await clickLocal('Library');await clickLocal('删除','reference/renamed.md');await until(async()=>!(await savedState()).files.some(f=>f.path==='reference/renamed.md'));
  assert.ok((await savedState()).files.some(f=>f.kind==='output'&&f.path.endsWith('ui-project-approved.txt')));
  result.checks.dsProjectArtifactsInLibrary=true;
  result.checks.nativeUiLibraryDelete=true;
  await clickLocal('线程');
  result.projects.localPanel=await local("root.querySelector('[data-panel]').innerText");
  fs.writeFileSync(path.join(output,'projects-observations.json'),JSON.stringify(seen,null,2));
}
