import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findProjectCLI} from './projects-cli.mjs';

test('owned Desktop CLI cache selects numeric versions and can appear after startup',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'projects-cli-cache-'));
  const install=version=>{const file=path.join(root,version,'abcd','claude.app/Contents/MacOS/claude');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture',{mode:0o700});return file;};
  try{
    assert.equal(findProjectCLI(root),undefined);assert.equal(findProjectCLI('relative'),undefined);
    install('2.1.9');const current=install('2.1.325');install('not-a-version');
    assert.equal(findProjectCLI(root),current);
    const unsafe=path.join(root,'9.0.0');fs.symlinkSync(path.join(root,'2.1.9'),unsafe,'dir');assert.equal(findProjectCLI(root),current);
    fs.unlinkSync(current);assert.match(findProjectCLI(root),/2\.1\.9/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
