// Local executor controls augment the vendor Projects page. They are mounted
// only in the isolated Projects build and never claim official cloud services.
(()=>{
  if(window.__claudeMomLocalProjects)return;window.__claudeMomLocalProjects=true;
  let project,host,root,panel,tab='threads',state,stream,refreshing=false;
  const node=(tag,text,attrs={})=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;};
  const button=(label,action)=>{const b=node('button',label,{type:'button'});b.onclick=()=>Promise.resolve(action()).catch(showError);return b;};
  const field=(form,label,name,kind='input',value='')=>{
    const l=node('label',label),input=node(kind,undefined,{name});input.value=value;input.dataset.baseline=value;
    if(kind==='input')input.type='text';l.append(input);form.append(l);return input;
  };
  const base=()=>`/v1/code/channels/${project}`;
  async function api(route,method='GET',value) {
    const r=await fetch(route,{method,headers:value===undefined?{}:{'content-type':'application/json'},
      ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(15000)});
    const body=await r.json();if(!r.ok)throw Error(body.error?.message||'本地项目操作失败');return body;
  }
  function showError(error){const e=root?.querySelector('[data-error]');if(e)e.textContent=error.message||String(error);}
  function status(value){return({queued:'排队',running:'运行中',completed:'本轮完成',failed:'失败',cancelled:'已取消',cancelling:'正在停止',resolved:'已结项',waiting:'等待处理',ready:'空闲',idle:'空闲',interrupted:'已中断'})[value]||value;}
  async function refresh() {
    if(refreshing||!project)return;refreshing=true;
    try{state=await api(base()+'/local');const pending=state.permissions.filter(p=>p.state==='pending').length;
      root.querySelector('[data-toggle]').textContent=`本地项目${pending?' · '+pending+' 项待批准':''}`;
      if(!panel.hidden&&!root.activeElement?.matches('input,textarea,select'))render();
    }catch(error){showError(error);}finally{refreshing=false;}
  }
  function formSubmit(form,label,handler){const submit=node('button',label,{type:'submit'});form.append(submit);form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{await handler(new FormData(form));await refresh();render();}catch(error){showError(error);}finally{submit.disabled=false;}};}
  function render() {
    window.__claudeMomLocalProjectDraft=false;
    const content=root.querySelector('[data-content]');content.replaceChildren();root.querySelector('[data-error]').textContent='';
    for(const b of root.querySelectorAll('[data-tab]'))b.setAttribute('aria-selected',String(b.dataset.tab===tab));
    if(!state)return;
    if(tab==='threads') {
      const form=node('form',undefined,{'data-form':'thread'});field(form,'线程名称','title');field(form,'任务','prompt','textarea');
      formSubmit(form,'启动独立线程',async values=>{await api(base()+'/threads','POST',Object.fromEntries(values));form.reset();});content.append(form);
      const repository=node('form',undefined,{'data-form':'repository'});field(repository,'项目 Git 仓库（留空使用内部仓库）','path','input',state.repository?.path||'');
      repository.append(node('p','新线程从仓库当前提交创建独立 worktree；已有线程保留自己的工作目录，改动等待审核。'));
      formSubmit(repository,'保存仓库设置',v=>api(base()+'/config','PATCH',{local_repository:v.get('path')}));content.append(repository);
      if(state.jobs.some(j=>['queued','running'].includes(j.state)))content.append(button('停止所有当前任务',()=>api(base()+'/cancel','POST',{}).then(refresh)));
      for(const thread of state.threads) {
        const row=node('section',undefined,{'data-thread':thread.id}),title=node('strong',thread.title),label=node('span',' · '+status(thread.state));row.append(title,label);
        row.append(button('查看 / 继续',async()=>{
          const result=await api(base()+'/threads/'+thread.id);const messages=node('pre',result.data.map(m=>m.body).join('\n\n'));
          row.append(messages);const reply=node('form');field(reply,'发送后续任务','body','textarea');
          formSubmit(reply,'发送',async values=>{await api(base()+'/messages','POST',{body:values.get('body'),in_reply_to_message_id:thread.id});reply.remove();});row.append(reply);
        }));
        if(['queued','running'].includes(thread.state))row.append(button('停止',()=>api(base()+'/threads/'+thread.id+'/cancel','POST',{}).then(refresh)));
        else row.append(button(thread.ds_status==='resolved'?'重开':'结项',()=>api(base()+'/threads/'+thread.id,'PATCH',{resolved:thread.ds_status!=='resolved'}).then(refresh)));
        if(thread.branch)row.append(node('p',`${thread.branch} · ${(thread.base_commit||'').slice(0,8)}`));
        const latest=state.jobs.filter(j=>j.thread_root_id===thread.id).at(-1);
        if(latest?.error)row.append(node('p',latest.error,{'data-task-error':''}));
        content.append(row);
      }
    }
    if(tab==='library') {
      const upload=node('input',undefined,{type:'file',multiple:'', 'aria-label':'导入 Library 文件'});
      upload.onchange=async()=>{
        try{for(const file of upload.files){if(file.size>8*1024*1024)throw Error('单个 Library 文件上限为 8 MiB');
          const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          const result=await api(base()+'/files:write','POST',{files:[{path:file.name,content:btoa(binary),overwrite:false}]});
          if(result.results.some(r=>r.error_reason))throw Error('同名文件已存在，请在编辑中修改，或先重命名。');}await refresh();}catch(error){showError(error);}
      };content.append(upload);
      const folder=node('form',undefined,{'data-form':'folder'});field(folder,'新建文件夹','path');formSubmit(folder,'新建文件夹',v=>api(base()+'/files:mkdir','POST',{path:v.get('path')}));content.append(folder);
      const form=node('form',undefined,{'data-form':'file'});field(form,'文件路径','path');field(form,'文本内容','content','textarea');
      formSubmit(form,'保存文本文件',async values=>{const bytes=new TextEncoder().encode(values.get('content'));let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
        const result=await api(base()+'/files:write','POST',{files:[{path:values.get('path'),content:btoa(binary),overwrite:true}]});
        if(result.results.some(r=>r.error_reason))throw Error('文件没有保存');form.reset();});content.append(form);
      for(const file of state.files){const row=node('section',undefined,{'data-file':file.path});row.append(node('strong',file.path),node('span',` · ${file.size_bytes} bytes`));
        row.append(button('查看 / 编辑',async()=>{const opened=await api(base()+'/files:open','POST',{path:file.path});
          const bytes=Uint8Array.from(atob(opened.content),c=>c.charCodeAt(0));
          form.elements.path.value=file.path;form.elements.content.value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);form.elements.content.focus();
        }),button('下载',async()=>{
          const opened=await api(base()+'/files:open','POST',{path:file.path}),bytes=Uint8Array.from(atob(opened.content),c=>c.charCodeAt(0));
          const url=URL.createObjectURL(new Blob([bytes])),link=node('a',undefined,{href:url,download:file.path.split('/').at(-1)});link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
        }),button('重命名',()=>{const rename=node('form',undefined,{'data-form':'rename'});field(rename,'新路径','path','input',file.path);
          formSubmit(rename,'确认重命名',async v=>{await api(base()+'/files:move','POST',{source_path:file.path,destination_path:v.get('path')});rename.remove();});row.append(rename);
        }),button('删除',async()=>{await api(base()+'/files:delete','POST',{path:file.path});await refresh();}));content.append(row);}
    }
    if(tab==='schedules') {
      const form=node('form',undefined,{'data-form':'schedule'});field(form,'任务名称','name');field(form,'任务内容','prompt','textarea');
      const kind=field(form,'类型','kind','select');for(const [value,label]of [['once','一次'],['cron','Cron']])kind.append(node('option',label,{value}));
      kind.dataset.baseline=kind.value;
      const at=field(form,'一次执行时间（含时区的 ISO 时间）','run_once_at','input',new Date(Date.now()+3600000).toISOString());
      const cron=field(form,'Cron（分 时 日 月 星期）','cron_expression','input','0 9 * * *');
      field(form,'时区','timezone','input',Intl.DateTimeFormat().resolvedOptions().timeZone||'Australia/Perth');
      formSubmit(form,'创建计划',async values=>{const input=Object.fromEntries(values);if(input.kind==='once')delete input.cron_expression;else delete input.run_once_at;
        await api(base()+'/schedules','POST',input);});content.append(form);
      content.append(node('p','由本地服务执行；睡眠期间暂停，恢复后合并错过的触发。工具操作仍需要批准。'));
      for(const s of state.schedules){const row=node('section',undefined,{'data-schedule':s.id});row.append(node('strong',s.name),node('p',s.enabled?`下次：${s.next_run_at} · ${s.timezone}`:'已暂停 / 一次任务已触发'));
        row.append(button(s.enabled?'暂停':'启用',()=>api('/v1/code/triggers/'+s.id,'PATCH',{enabled:!s.enabled}).then(refresh)),
          button('立即运行',()=>api('/v1/code/triggers/'+s.id+'/run','POST',{}).then(refresh)),
          button('删除',()=>api('/v1/code/triggers/'+s.id,'DELETE').then(refresh)));content.append(row);}
    }
    if(tab==='permissions') {
      const pending=state.permissions.filter(p=>p.state==='pending');if(!pending.length)content.append(node('p','没有等待批准的操作。'));
      for(const p of pending){const row=node('section',undefined,{'data-permission':p.id});row.append(node('strong',p.tool_name),node('pre',JSON.stringify(p.input,null,2)));
        row.append(button('仅允许这次',()=>api(base()+'/permissions/'+p.id,'POST',{decision:'allow'}).then(refresh)),
          button('拒绝',()=>api(base()+'/permissions/'+p.id,'POST',{decision:'deny'}).then(refresh)));content.append(row);}
    }
  }
  function mount() {
    const id=/\/(?:epitaxy|code)\/project\/(chan_[A-Za-z0-9_-]+)/.exec(location.pathname)?.[1];
    if(id===project)return;stream?.close();host?.remove();window.__claudeMomLocalProjectDraft=false;project=id;if(!id)return;
    host=node('div',undefined,{id:'claudemom-local-projects'});
    const foreground=getComputedStyle(document.body).color.match(/[\d.]+/g)?.slice(0,3).map(Number);
    host.style.colorScheme=foreground&&foreground.reduce((n,v)=>n+v,0)>420?'dark':'light';
    root=host.attachShadow({mode:'open'});
    const style=node('style');style.textContent=`:host{font:14px system-ui;color:var(--text-primary,#292723)}*{box-sizing:border-box}button,input,textarea,select{font:inherit;color:inherit}button{border:1px solid #ddd9d3;border-radius:8px;background:var(--bg-100,#faf9f6);padding:7px 10px;cursor:pointer}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #b76143;outline-offset:2px}button[aria-selected=true]{background:#eee7df}button:disabled{opacity:.5;cursor:wait}[data-toggle]{position:fixed;right:18px;bottom:18px;z-index:100001}[data-panel]{position:fixed;right:18px;top:70px;bottom:64px;width:min(460px,calc(100vw - 36px));z-index:100002;background:var(--bg-100,#faf9f6);border:1px solid #ddd9d3;border-radius:14px;box-shadow:0 8px 30px #0002;display:flex;flex-direction:column}[hidden]{display:none!important}header,nav{display:flex;gap:6px;padding:12px;border-bottom:1px solid #ddd9d3}header{align-items:center;justify-content:space-between}main{overflow:auto;padding:16px}form,section{display:grid;gap:9px;padding:12px 0;border-bottom:1px solid #ddd9d3}label{display:grid;gap:5px}input,textarea,select{border:1px solid #d2ccc3;border-radius:7px;padding:8px;background:transparent;width:100%}textarea{min-height:80px;resize:vertical}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}section button{justify-self:start}p{line-height:1.5;color:#6b665f}[data-error]{color:#a33;padding:0 14px}`;root.append(style);
    // Vendor theme variables can be HSL channel triples rather than colors.
    // System colors keep this permission surface opaque in both appearances.
    style.textContent+=':host{color:CanvasText}button{background:Canvas}[data-panel]{background:Canvas}';
    const toggle=button('本地项目',()=>{panel.hidden=!panel.hidden;if(!panel.hidden){render();void refresh();}});toggle.dataset.toggle='';root.append(toggle);
    panel=node('aside',undefined,{'data-panel':'',role:'dialog','aria-label':'本地 Projects 管理'});panel.hidden=true;
    panel.addEventListener('input',()=>{window.__claudeMomLocalProjectDraft=[...panel.querySelectorAll('input:not([type=file]),textarea,select')].some(e=>e.value!==(e.dataset.baseline||''));});
    panel.addEventListener('keydown',e=>{if(e.key==='Escape')panel.hidden=true;});
    const header=node('header');header.append(node('strong','本地 Projects'),button('关闭',()=>{panel.hidden=true;}));panel.append(header);
    const nav=node('nav',undefined,{role:'tablist'});for(const[id,label]of [['threads','线程'],['library','Library'],['schedules','计划任务'],['permissions','权限确认']]){
      const b=button(label,()=>{tab=id;render();});b.dataset.tab=id;b.setAttribute('role','tab');nav.append(b);}panel.append(nav,node('p','',{ 'data-error':'',role:'alert'}),node('main',undefined,{'data-content':''}));root.append(panel);document.body.append(host);
    stream=new EventSource(base()+'/messages/stream');stream.addEventListener('local_project_state',()=>void refresh());void refresh();
  }
  let pending=false;const update=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;mount();});};
  addEventListener('popstate',update);addEventListener('pageshow',update);
  new MutationObserver(update).observe(document.documentElement,{childList:true,subtree:true});
  if(document.body)mount();else addEventListener('DOMContentLoaded',mount,{once:true});
})();
