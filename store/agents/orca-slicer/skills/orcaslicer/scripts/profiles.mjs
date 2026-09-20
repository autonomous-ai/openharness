import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,join,parse} from 'node:path';
import {createHash} from 'node:crypto';
const networkFields=['print_host','print_host_webui','printhost_apikey','printhost_port','printhost_cafile','printhost_user','printhost_password','printhost_authorization_type','flashforge_serial_number'];
const credentialFields=networkFields.filter(key=>!['printhost_port','printhost_authorization_type'].includes(key));
function nonempty(value){return Array.isArray(value)?value.some(nonempty):value!==undefined&&value!==null&&value!==''&&value!==false&&value!==0;}
async function regular(file){
  const path=resolve(file);let current=parse(path).root;
  for(const component of path.slice(current.length).split(/[\\/]/).filter(Boolean)){
    current=join(current,component);
    // /tmp may itself be an OS alias; callers supply real workspace/profile
    // roots. Resolve these roots before calling this function.
    if((await lstat(current)).isSymbolicLink())throw new Error('Profile paths must not contain symlinks: '+basename(path));
  }
  const info=await lstat(path);
  if(!info.isFile()||info.size>1024*1024)throw new Error('Profile must be a regular JSON file under 1 MiB: '+basename(path));
  return readFile(path);
}
export async function profileWithSources(file,chain=[]){
  // Canonicalize the selected directory (including macOS /tmp and /var
  // aliases), but never follow a selected file symlink. Workspace callers
  // separately validate every component against their source allowlist.
  const path=join(await realpath(dirname(resolve(file))),basename(file));
  if(chain.includes(path)||chain.length>=20)throw new Error('Cyclic or overly deep profile inheritance.');
  const bytes=await regular(path),value=JSON.parse(bytes);
  if(!value||Array.isArray(value)||typeof value!=='object'||typeof value.name!=='string'||!value.name.trim())throw new Error('Invalid profile: '+basename(path));
  for(const key of credentialFields)if(nonempty(value[key]))throw new Error('Remove printer connection/credential field '+key+' from the exported slicing profile before bundling it. No connection is needed.');
  let parent={profile:{},sources:[]};
  if(value.inherits){
    if(typeof value.inherits!=='string'||basename(value.inherits)!==value.inherits||value.inherits.includes('\\')||value.inherits.startsWith('.'))throw new Error('Profile parent must be a sibling profile name.');
    const parentFile=resolve(dirname(path),value.inherits+'.json');
    try{parent=await profileWithSources(parentFile,[...chain,path]);}catch(error){throw new Error('Cannot resolve '+value.name+' parent '+value.inherits+': '+error.message);}
  }
  const merged={...parent.profile,...value,instantiation:'true'};delete merged.inherits;
  for(const key of networkFields)delete merged[key];
  return {profile:merged,sources:[...parent.sources,{path,bytes,sha256:createHash('sha256').update(bytes).digest('hex')}]};
}
export async function resolveProfile(file,chain=[]){return (await profileWithSources(file,chain)).profile;}
export async function unchangedProfiles(profiles){
  const seen=new Set();
  for(const item of profiles.flatMap(profile=>profile.sources)){
    if(seen.has(item.path))continue;seen.add(item.path);
    if(createHash('sha256').update(await regular(item.path)).digest('hex')!==item.sha256)throw new Error('A profile changed during slicing; rebuild: '+basename(item.path));
  }
}
