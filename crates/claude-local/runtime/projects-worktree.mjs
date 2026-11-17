// Adapted from DSH Projects, Apache-2.0. Attribution and modifications are
// recorded in third-party/dsh-projects/UPSTREAM.md.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function git(directory,args,required=true) {
  const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{encoding:'utf8',timeout:30000,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});
  if(required&&result.status!==0)throw Error('Local project Git operation failed: '+(result.stderr||result.error?.message||'unknown error').slice(0,600));
  return result.status===0?(args.includes('-z')?result.stdout:result.stdout.trim()):null;
}
export function createThreadWorktree(projectDir,threadId,title,destination,baseCommit='HEAD') {
  const repo=git(projectDir,['rev-parse','--show-toplevel']);
  const short=String(threadId).replace(/^(thread-|cmsg_)/,'').replaceAll('-','').slice(0,12);
  if(!/^[A-Za-z0-9_]{8,12}$/.test(short))throw Error('Invalid local thread identity');
  const slug=String(title||'task').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'task';
  const branch='thread/'+short+'-'+slug,worktreePath=path.resolve(destination),commit=git(repo,['rev-parse','--verify',baseCommit+'^{commit}']);
  if(fs.existsSync(worktreePath)) {
    if(fs.lstatSync(worktreePath).isSymbolicLink())throw Error('Worktree path became a symlink');
    const common=git(worktreePath,['rev-parse','--git-common-dir'],false);
    if(!common)throw Error('An existing thread directory is not a Git worktree');
    if(fs.realpathSync(git(worktreePath,['rev-parse','--show-toplevel']))!==fs.realpathSync(worktreePath))throw Error('An existing directory is not a dedicated thread worktree');
    const expected=path.resolve(repo,git(repo,['rev-parse','--git-common-dir']));
    if(fs.realpathSync(path.resolve(worktreePath,common))!==fs.realpathSync(expected))throw Error('Thread belongs to another repository');
    return{repo,worktreePath,branch:git(worktreePath,['branch','--show-current']),baseCommit:commit};
  }
  fs.mkdirSync(path.dirname(worktreePath),{recursive:true,mode:0o700});
  git(repo,['worktree','add','-b',branch,worktreePath,commit]);
  return{repo,worktreePath,branch,baseCommit:commit};
}
export function ensureManagedRepository(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(!fs.existsSync(path.join(directory,'.git'))) {
    git(directory,['init','--initial-branch=main']);
    git(directory,['-c','user.name=ClaudeMom Local Projects','-c','user.email=local-projects@localhost','commit','--allow-empty','-m','Initialize local project workspace']);
  }
  return directory;
}
export function changedFiles(directory) {
  const tracked=git(directory,['diff','--no-ext-diff','--no-textconv','--name-only','-z','HEAD'],false)||'',untracked=git(directory,['ls-files','--others','--exclude-standard','-z'],false)||'';
  return [...new Set((tracked+'\0'+untracked).split('\0').filter(Boolean))].filter(name=>!name.split('/').some(p=>['.git','.claudemom-library','node_modules'].includes(p))).slice(0,1000);
}
export function repositoryInfo(directory) {
  const root=git(directory,['rev-parse','--show-toplevel']),commit=git(root,['rev-parse','HEAD']);
  return{root,commit,branch:git(root,['branch','--show-current']),dirty:!!git(root,['status','--porcelain'])};
}
