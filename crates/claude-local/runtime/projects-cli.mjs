import fs from 'node:fs';
import path from 'node:path';

// Read only the Desktop cache selected by the host. Never use a user's PATH
// CLI or import its personal account, settings, hooks, or MCP configuration.
export function findProjectCLI(cache) {
  if(typeof cache!=='string'||!path.isAbsolute(cache))return undefined;
  try{
    const versions=fs.readdirSync(cache,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^\d+\.\d+\.\d+$/.test(d.name))
      .map(d=>d.name).sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return y[0]-x[0]||y[1]-x[1]||y[2]-x[2];});
    for(const version of versions)for(const hash of fs.readdirSync(path.join(cache,version),{withFileTypes:true})){
      if(!hash.isDirectory()||!/^[a-f0-9]+$/.test(hash.name))continue;
      const binary=path.join(cache,version,hash.name,'claude.app/Contents/MacOS/claude');
      try{if(!fs.lstatSync(binary).isFile())continue;fs.accessSync(binary,fs.constants.X_OK);return binary;}catch{}
    }
  }catch{}
  return undefined;
}
