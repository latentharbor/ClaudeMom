import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {projectSandbox,sandboxCommand,ProjectSandboxError} from './projects-sandbox.mjs';

test('Sandbox is required on unsupported platforms',()=>{
  assert.throws(()=>projectSandbox({platform:'linux'}),e=>e instanceof ProjectSandboxError&&e.code==='project_sandbox_unavailable');
});

test('full process and MCP-like child cannot escape filesystem, IPC or broker boundaries',{skip:process.platform!=='darwin',timeout:30000},async()=>{
  const root=fs.mkdtempSync('/private/tmp/cm-sb-'),dirs={};
  for(const name of ['workspace','configDir','tmp','sockets','runtimeDir','control','private']){dirs[name]=path.join(root,name);fs.mkdirSync(dirs[name]);}
  const secret=path.join(dirs.private,'credential'),otherHistory=path.join(dirs.private,'other-thread.jsonl');
  fs.writeFileSync(secret,'PRIVATE_SENTINEL');fs.writeFileSync(otherHistory,'OTHER_SESSION');
  fs.mkdirSync(path.join(dirs.workspace,'.claudemom-library'));fs.writeFileSync(path.join(dirs.workspace,'.claudemom-library','reference'),'READ_ONLY');
  fs.writeFileSync(path.join(dirs.workspace,'.git'),'HOST_OWNED_GIT');
  fs.symlinkSync(secret,path.join(dirs.workspace,'escape-link'));
  const mcpFile=path.join(dirs.control,'mcp.json');fs.writeFileSync(mcpFile,'{}');
  let otherHits=0;
  const broker=http.createServer((req,res)=>res.end('OWNED_BROKER')),other=http.createServer((req,res)=>{otherHits++;res.end('wrong');});
  const outsideIPC=net.createServer(socket=>socket.end('wrong'));
  broker.listen(0,'127.0.0.1');other.listen(0,'127.0.0.1');outsideIPC.listen(path.join(root,'outside.sock'));
  await Promise.all([once(broker,'listening'),once(other,'listening'),once(outsideIPC,'listening')]);
  const plan=projectSandbox({...dirs,binary:process.execPath,nodeBinary:process.execPath,mcpFile,port:broker.address().port});
  const profileFile=path.join(dirs.control,'sandbox.sb');fs.writeFileSync(profileFile,plan.profile);
  const code=`const fs=require('fs'),cp=require('child_process'),net=require('net');(async()=>{
    const r={};const blocked=f=>{try{f();return false;}catch{return true;}};
    fs.writeFileSync('owned.txt','ok');r.ownWrite=true;r.ownRead=fs.readFileSync('owned.txt','utf8')==='ok';
    r.privateRead=blocked(()=>fs.readFileSync(${JSON.stringify(secret)}));r.otherHistory=blocked(()=>fs.readFileSync(${JSON.stringify(otherHistory)}));
    r.symlinkRead=blocked(()=>fs.readFileSync('escape-link'));r.outsideWrite=blocked(()=>fs.writeFileSync(${JSON.stringify(secret)},'bad'));
    r.controlWrite=blocked(()=>fs.writeFileSync(${JSON.stringify(profileFile)},'bad'));
    r.libraryRead=fs.readFileSync('.claudemom-library/reference','utf8')==='READ_ONLY';r.libraryWrite=blocked(()=>fs.writeFileSync('.claudemom-library/reference','bad'));
    r.gitWrite=blocked(()=>fs.writeFileSync('.git','bad'));r.mcpConfig=fs.readFileSync(${JSON.stringify(mcpFile)},'utf8')==='{}';
    const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('fs').readFileSync(${JSON.stringify(secret)});process.exit(7);}catch{console.log('MCP_CHILD_DENIED');}`)}],{encoding:'utf8'});
    r.childInherited=child.status===0&&child.stdout.includes('MCP_CHILD_DENIED');
    const escape=cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)',process.execPath,'-e',${JSON.stringify(`require('fs').readFileSync(${JSON.stringify(secret)})`)}],{encoding:'utf8'});
    r.noSandboxEscape=escape.status!==0;
    r.broker=(await(await fetch('http://127.0.0.1:${broker.address().port}')).text())==='OWNED_BROKER';
    try{await fetch('http://127.0.0.1:${other.address().port}',{signal:AbortSignal.timeout(1000)});r.otherNetwork=false;}catch{r.otherNetwork=true;}
    r.otherIPC=await new Promise(resolve=>{const s=net.connect(${JSON.stringify(path.join(root,'outside.sock'))});s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',()=>resolve(true));});
    console.log(JSON.stringify(r));})().catch(e=>{console.error(e);process.exitCode=1;});`;
  try{
    const command=sandboxCommand(plan,profileFile,process.execPath,['-e',code]);
    const actor=spawn(command.command,command.args,{cwd:dirs.workspace,env:{PATH:'/usr/bin:/bin',TMPDIR:dirs.tmp},stdio:['ignore','pipe','pipe']});
    let out='',err='';actor.stdout.on('data',p=>out+=p);actor.stderr.on('data',p=>err+=p);const [status,signal]=await once(actor,'close');
    assert.equal(status,0,err+' signal='+signal);const checks=JSON.parse(out);assert.equal(Object.keys(checks).length,16);
    for(const [name,value]of Object.entries(checks))assert.equal(value,true,name);assert.equal(otherHits,0);
    assert.equal(fs.readFileSync(secret,'utf8'),'PRIVATE_SENTINEL');
    assert.throws(()=>sandboxCommand(plan,path.join(root,'missing.sb'),process.execPath,['-e','process.exit(0)']),ProjectSandboxError,'invalid sandbox never starts an unrestricted actor');
  }catch(error){if(error.diagnostic)console.error(error.diagnostic);throw error;}
  finally{broker.closeAllConnections();other.closeAllConnections();await Promise.all([new Promise(r=>broker.close(r)),new Promise(r=>other.close(r)),new Promise(r=>outsideIPC.close(r))]);fs.rmSync(root,{recursive:true,force:true});}
});
