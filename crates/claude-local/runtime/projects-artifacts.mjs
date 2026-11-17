// Runs inside the same OS boundary as the actor. The trusted controller never
// follows model-controlled worktree paths with its own filesystem privileges.
import fs from 'node:fs';
import path from 'node:path';
import {changedFiles} from './projects-worktree.mjs';
import {within} from './third-party/ds-project/library.js';

const root=process.argv[2],files=[],errors=[];let total=0;
for(const name of changedFiles(root))try{
  const file=within(root,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile())continue;
    if(stat.nlink!==1)throw Error('hard links are not exportable');
    if(stat.size>8*1024*1024||total+stat.size>8*1024*1024)throw Error('artifact capture size limit');
    const content=fs.readFileSync(fd);total+=content.length;files.push({path:name,content:content.toString('base64')});
  }finally{fs.closeSync(fd);}
}catch{errors.push({path:name,error:'Output could not be read within the task Sandbox'});}
process.stdout.write(JSON.stringify({files,errors}));
