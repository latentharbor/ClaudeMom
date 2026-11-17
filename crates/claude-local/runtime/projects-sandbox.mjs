// A mandatory outer macOS Seatbelt boundary around the complete CLI process.
// MCP, file tools, shell commands, and their descendants inherit this boundary.
// No option, environment variable, or launch retry can disable it.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const executor='/usr/bin/sandbox-exec';
export class ProjectSandboxError extends Error {
  constructor(message){super(message);this.name='ProjectSandboxError';this.code='project_sandbox_unavailable';}
}
function canonical(value) {
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))throw new ProjectSandboxError('Invalid Sandbox path');
  return fs.realpathSync(value);
}
function gitMetadata(workspace) {
  try{
    const marker=path.join(workspace,'.git');if(!fs.lstatSync(marker).isFile())return [];
    const link=/^gitdir: ([^\n]+)\n?$/.exec(fs.readFileSync(marker,'utf8'));if(!link)return [];
    const own=canonical(path.resolve(workspace,link[1])),common=path.join(own,'commondir');
    return fs.existsSync(common)?[canonical(path.resolve(own,fs.readFileSync(common,'utf8').trim()))]:[own];
  }catch{return [];}
}
function systemReads() {
  const paths=['/System','/bin','/sbin','/usr/bin','/usr/sbin','/usr/lib','/usr/libexec','/usr/share','/usr/standalone',
    '/private/etc','/private/preboot','/private/var/db/dyld','/private/var/db/timezone',
    '/Library/Apple','/Library/Developer','/Library/Frameworks',
    ...['/opt/homebrew','/usr/local'].flatMap(root=>['bin','lib','libexec','Cellar','opt','share','Frameworks'].map(p=>path.join(root,p)))];
  try{for(const e of fs.readdirSync('/Applications',{withFileTypes:true}))if(e.isDirectory()&&/^Xcode[^/]*\.app$/.test(e.name))paths.push(path.join('/Applications',e.name,'Contents/Developer'));}catch{}
  return paths.filter(p=>fs.existsSync(p)).map(canonical);
}
const quote=value=>JSON.stringify(value);
const sub=value=>`(subpath ${quote(value)})`;
const literal=value=>`(literal ${quote(value)})`;

export function projectSandbox({workspace,configDir,tmp,sockets,binary,nodeBinary,runtimeDir,mcpFile,port,platform=process.platform}) {
  if(platform!=='darwin')throw new ProjectSandboxError('Local Projects require the macOS process Sandbox; execution was blocked');
  try{fs.accessSync(executor,fs.constants.X_OK);}catch{throw new ProjectSandboxError('macOS Sandbox is unavailable; execution was blocked');}
  if(!Number.isInteger(port)||port<1||port>65535)throw new ProjectSandboxError('Invalid private task broker');
  const writable=[workspace,configDir,tmp,sockets].map(canonical);
  const executable=canonical(binary),node=canonical(nodeBinary),runtime=canonical(runtimeDir),mcp=canonical(mcpFile);
  let bundle=path.dirname(executable);while(bundle!==path.dirname(bundle)&&!bundle.endsWith('.app'))bundle=path.dirname(bundle);
  const readable=[...systemReads(),...writable,runtime,...gitMetadata(workspace)];
  if(bundle.endsWith('.app'))readable.push(bundle);
  const profile=['(version 1)','(deny default)',
    '(allow process-exec process-fork)',
    '(allow process-info* signal mach-priv-task-port (target same-sandbox))',
    '(allow user-preference-read)',
    '(allow ipc-posix-shm ipc-posix-sem)',
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.")',
    '  (sysctl-name "kern.argmax") (sysctl-name "kern.maxfiles") (sysctl-name "kern.maxfilesperproc")',
    '  (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion")',
    '  (sysctl-name "kern.osproductversion") (sysctl-name "kern.version") (sysctl-name "kern.hostname")',
    '  (sysctl-name "kern.tcsm_available") (sysctl-name "kern.tcsm_enable") (sysctl-name "kern.usrstack64")',
    '  (sysctl-name "kern.osvariant_status") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.willshutdown")',
    '  (sysctl-name "kern.bootargs") (sysctl-name "kern.maxproc") (sysctl-name "kern.ngroups")',
    '  (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "sysctl.proc_cputype")',
    '  (sysctl-name "vm.loadavg") (sysctl-name "machdep.ptrauth_enabled"))',
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    '(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership")',
    '  (global-name "com.apple.bsd.dirhelper"))',
    '(allow file-read-metadata)',
    `(allow file-read* ${[...new Set(readable)].map(sub).join(' ')} ${[executable,node,mcp,'/dev/null','/dev/zero','/dev/random','/dev/urandom','/dev/tty'].map(literal).join(' ')} (subpath "/dev/fd"))`,
    `(allow file-write* ${writable.map(sub).join(' ')} (literal "/dev/null") (subpath "/dev/fd"))`,
    // A read-only snapshot and host-owned Git linkage stay read-only even
    // though their parent workspace is writable.
    `(deny file-write* ${sub(path.join(writable[0],'.claudemom-library'))} ${sub(path.join(writable[0],'.git'))})`,
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    `(allow network-outbound (remote tcp "localhost:${port}"))`,
    '(allow system-socket (socket-domain AF_UNIX))',
    `(allow network-bind (local unix-socket ${sub(writable[3])}))`,
    `(allow network-outbound (remote unix-socket ${sub(writable[3])}))`].join('\n')+'\n';
  return{executor,profile,version:1,backend:'macos-seatbelt'};
}

export function sandboxCommand(plan,profileFile,binary,args) {
  // The preflight runs on the CI runner / user's machine, never the target
  // application. Any unsupported/denied/invalid profile stops before the CLI.
  const checked=spawnSync(executor,['-f',profileFile,'/usr/bin/true'],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
  if(checked.status!==0){const error=new ProjectSandboxError('The required process Sandbox could not start; execution was blocked');
    error.diagnostic=String(checked.stderr||checked.error?.message||checked.signal||checked.status).slice(0,4000);throw error;}
  return{command:executor,args:['-f',profileFile,binary,...args]};
}
