import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyProjectsLab({frames,evaluate,clickText,until,result,root,output}) {
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
  const before=await evaluate(frame,'location.pathname');
  const prefix=before.startsWith('/epitaxy')?'/epitaxy':'/code';
  await evaluate(frame,`(()=>{history.pushState({},'',${JSON.stringify(prefix+'/projects/browse')});dispatchEvent(new PopStateEvent('popstate'));return true;})()`);
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
    return evaluate(current,"(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>/^(New project|Create project|新建项目|创建项目)$/i.test(e.textContent.trim()));if(!e)return false;e.click();return true;})()");
  },30000);
  assert.equal(opened,true);
  await delay(2000);current=await inspect();result.projects.dialog=current.state;
  const filled=await evaluate(current.frame,"(()=>{const dialog=document.querySelector('[role=dialog]')||document;const e=[...dialog.querySelectorAll('input')].find(e=>e.type!=='hidden'&&e.getBoundingClientRect().width>20);if(!e)return false;e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'LOCAL_PROJECTS_CI');e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  assert.equal(filled,true,'Project name field');
  await delay(500);
  assert.equal(await evaluate(current.frame,"(()=>{const dialog=document.querySelector('[role=dialog]')||document;const e=[...dialog.querySelectorAll('button')].find(e=>!e.disabled&&/^(Create|Create project|创建|创建项目)$/i.test(e.textContent.trim()));if(!e)return false;e.click();return true;})()"),true);
  const file=path.join(root,'projects-lab/projects.json');
  const saved=await until(()=>{try{const s=JSON.parse(fs.readFileSync(file));return s.channels.some(c=>c.name==='LOCAL_PROJECTS_CI')?s:null;}catch{return null;}});
  assert.equal(saved.channels.length,1);
  result.projects.createdId=saved.channels[0].id;
  result.checks.nativeProjectCreatedInLocalStore=true;
  await delay(2000);result.projects.created=(await inspect()).state;
  fs.writeFileSync(path.join(output,'projects-observations.json'),JSON.stringify(seen,null,2));
}
