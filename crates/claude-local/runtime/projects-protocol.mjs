// The channel/file/memory forms follow ClaudeLift's observed API contract.
// Reference only; no ClaudeLift runtime or official credentials are used.
// https://github.com/gfsaaser24/ClaudeLift/blob/ee879c939a0686a7ecae3a34892fb0dec8bdf3e2/docs/NEW-LAYOUT-SPEC.md
import crypto from 'node:crypto';
export const sourcePins=Object.freeze({
  dsProject:'25f6d7d816f381bb1a3cb097c6fdcda8afdcb71d',
  dshProjects:'db930cbe1a53c9bd117c0507a3736ca83dea9dce',
  claudeLift:'ee879c939a0686a7ecae3a34892fb0dec8bdf3e2',
});
export const channelId=id=>'chan_'+id.replaceAll('-','');
export const messageId=id=>'cmsg_'+id.replaceAll('-','');
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const stableUUID=value=>{const h=sha(value).slice(0,32);return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
export function rawUUID(id,prefix) {
  const h=String(id).replace(new RegExp('^'+prefix),'');
  if(!/^[a-f0-9]{32}$/i.test(h))throw Error('Invalid local project identity');
  return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function externalFileId(uuid) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n=BigInt('0x'+uuid.replaceAll('-','')),s='';
  while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}
  return'file_01'+s.padStart(22,'1');
}
export function memoryId(project,name){return'mem_'+sha(project+':'+name).slice(0,32);}
export const page=data=>({data,has_more:false,next_cursor:null});
export function json(res,value,status=200) {
  const bytes=Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','x-claudemom-projects-backend':'ds-project-local'});res.end(bytes);
}
export async function bytes(req,limit=16*1024*1024) {
  const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw Error('Local project request is too large');parts.push(part);}return Buffer.concat(parts);
}
export async function body(req){const raw=await bytes(req),value=raw.length?JSON.parse(raw):{};
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('A JSON object is required');return value;}
export function privateJSON(file,value,fs) {const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
