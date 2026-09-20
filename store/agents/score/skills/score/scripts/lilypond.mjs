// Official LilyPond binaries, managed beside Harness runtimes. No global package manager.
import { access,mkdir,mkdtemp,readFile,rename,rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION='2.26.0';
// GitLab's official release package 58476196, package_files API, checked 2026-09-20.
const releases={
  'darwin-x64':{asset:'darwin-x86_64',sha256:'6dcbca34b13ad6d4ba3606a0b48edd02688284fcd52e9c00141242df1996a148'},
  'darwin-arm64':{asset:'darwin-arm64',sha256:'18ffc454fef3753c26a015d95a3c232f89b22f052b897c046e0198740a1221be'},
  'linux-x64':{asset:'linux-x86_64',sha256:'cd8a097a9f52cb2b9f4e7914774786f203f4fc61fcd299afcbb63c23fa5c6b24'},
};
export function releaseFor(platform=process.platform,arch=process.arch){
  const release=releases[platform+'-'+arch];
  if(!release)throw new Error(`Score has no managed LilyPond download for ${platform}/${arch}. A working LilyPond 2.24.3+ on PATH or LILYPOND_BIN can still be used.`);
  const name=`lilypond-${VERSION}-${release.asset}`;
  return {...release,name,url:`https://gitlab.com/api/v4/projects/lilypond%2Flilypond/packages/generic/lilypond/${VERSION}/${name}.tar.gz`};
}
export function runtimeRoot(env=process.env){return env.SCORE_RUNTIME_DIR||join(env.ADAPTER_RUNTIME_DIR||join(homedir(),'.harness','runtime'),'score');}
export function probeLilypond(bin,env=process.env){
  const result=spawnSync(bin,['--version'],{env,encoding:'utf8',timeout:10000,maxBuffer:256*1024});
  const line=(result.stdout||'').split('\n')[0],match=line.match(/^GNU LilyPond (\d+)\.(\d+)\.(\d+)/);
  if(result.error||result.status!==0||!match||Number(match[1])<2||(Number(match[1])===2&&(Number(match[2])<24||(Number(match[2])===24&&Number(match[3])<3))))return null;
  return {bin,version:match.slice(1,4).join('.'),line};
}
export async function findLilypond({env=process.env,platform=process.platform,arch=process.arch,probe=probeLilypond}={}){
  if(env.LILYPOND_BIN){const found=probe(env.LILYPOND_BIN,env);if(!found)throw new Error('The configured LILYPOND_BIN cannot run LilyPond 2.24.3+: '+env.LILYPOND_BIN);return found;}
  let release;try{release=releaseFor(platform,arch);}catch{}
  const candidates=[release&&join(runtimeRoot(env),release.name,'bin/lilypond'),'lilypond'];
  if(platform==='darwin')candidates.push('/opt/homebrew/bin/lilypond','/usr/local/bin/lilypond','/Applications/LilyPond.app/Contents/Resources/bin/lilypond');
  for(const bin of candidates.filter(Boolean)){const found=probe(bin,env);if(found)return found;}
  return null;
}
function command(name,args){
  const run=spawnSync(name,args,{encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
  if(run.error||run.status!==0)throw new Error(`${name} failed: ${run.error?.message||(run.stderr||'').trim().slice(-1600)||'exit '+run.status}`);
  return run.stdout;
}
export async function downloadArchive(url,path){command('curl',['-fsSL','--retry','2','--connect-timeout','20','--max-time','540','--output',path,url]);}
export async function unpackArchive(archive,directory){
  const names=command('tar',['-tzf',archive]).split('\n').filter(Boolean);
  if(!names.length||names.some(name=>!name.startsWith('lilypond-'+VERSION+'/')||name.split('/').includes('..')))throw new Error('Unexpected LilyPond archive layout; nothing installed.');
  command('tar',['-xzf',archive,'--strip-components=1','-C',directory]);
}
export async function ensureLilypond({env=process.env,platform=process.platform,arch=process.arch,probe=probeLilypond,download=downloadArchive,unpack=unpackArchive,getRelease=releaseFor,log=console.log}={}){
  const existing=await findLilypond({env,platform,arch,probe});if(existing)return existing;
  const release=getRelease(platform,arch),root=runtimeRoot(env),target=join(root,release.name);
  await mkdir(root,{recursive:true});const scratch=await mkdtemp(join(root,'.lilypond-install-'));
  const archive=join(scratch,'release.tar.gz'),stage=join(scratch,'runtime');let previous;
  try{
    log(`Downloading LilyPond ${VERSION} for Score…`);await download(release.url,archive);
    const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
    if(digest!==release.sha256)throw new Error('LilyPond download did not match its pinned checksum. Nothing was installed; retry the download.');
    log('Verifying and preparing the music engraver…');await mkdir(stage);await unpack(archive,stage);
    if(probe(join(stage,'bin/lilypond'),env)?.version!==VERSION)throw new Error('The downloaded LilyPond could not run on this machine.');
    const bin=join(target,'bin/lilypond');if(probe(bin,env))return probe(bin,env);
    try{await access(target);previous=target+'.previous-'+randomUUID();await rename(target,previous);}catch(error){if(error.code!=='ENOENT')throw error;}
    try{await rename(stage,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code)||!probe(bin,env))throw error;}
    const installed=probe(bin,env);if(!installed)throw new Error('LilyPond could not run from its installed location.');
    return installed;
  }catch(error){
    if(previous){await rm(target,{recursive:true,force:true});await rename(previous,target);}
    throw error;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
export async function resolveLilypond(options){
  const found=await findLilypond(options);if(found)return found.bin;
  throw new Error('Score’s LilyPond runtime is missing. Run Score setup or Retry its installation.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const found=process.argv.includes('--install')?await ensureLilypond():await findLilypond();
    if(!found)throw new Error('Score’s LilyPond runtime is missing. Retry installation to download it.');
    console.log(`ok   LilyPond ${found.version} · ${found.bin}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
