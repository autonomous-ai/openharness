import {access,readFile,writeFile,mkdir,mkdtemp,readdir,rename,copyFile,rm,stat} from 'node:fs/promises';
import {constants} from 'node:fs';import {spawnSync} from 'node:child_process';import {resolve,join,dirname,isAbsolute,relative} from 'node:path';
import {parseGcode} from './gcode.mjs';
import {resolveProfile} from './profiles.mjs';
const ws=resolve(process.env.HARNESS_WORKSPACE||process.cwd()),meta=join(ws,'.harness');await mkdir(meta,{recursive:true});
const verdict=async(ready,summary,findings=[])=>writeFile(join(meta,'verdict.json'),JSON.stringify({spec:1,ready,summary,findings,artifact:ready?'preview.html':null,updatedAt:new Date().toISOString()},null,2)+'\n');
await verdict(false,'Loading explicit slicer profiles…');let stage,log='';
try{
  const config=JSON.parse(await readFile(join(ws,'slice-config.json'),'utf8'));
  if(!['demo','custom'].includes(config.mode))throw new Error('slice-config.json mode must be demo or custom.');
  let bin=process.env.ORCA_BIN;if(!bin){bin=spawnSync('/bin/sh',['-c','command -v orca-slicer || command -v orcaslicer'],{encoding:'utf8'}).stdout.trim()||'/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer';}
  await access(bin,constants.X_OK).catch(()=>{throw new Error('OrcaSlicer not found. Install OrcaSlicer 2.4.2 or set ORCA_BIN. PrusaSlicer is not a CLI substitute.');});
  const profiles=process.env.ORCA_PROFILES_DIR||resolve(dirname(bin),'../Resources/profiles');
  stage=await mkdtemp(join(meta,'slice-'));
  const settings=[],resolvedProfiles={};
  for(const key of ['printer','process','filament']){
    if(typeof config[key]!=='string'||!config[key]||config[key].includes(';'))throw new Error('Provide one '+key+' JSON profile in slice-config.json.');
    const path=resolve(config.mode==='demo'?profiles:ws,config[key]);
    const profile=await resolveProfile(path);
    const flat=join(stage,key+'.json');await writeFile(flat,JSON.stringify(profile,null,2));settings.push(flat);resolvedProfiles[key]=profile;
  }
  if(typeof config.model!=='string'||!config.model.toLowerCase().endsWith('.stl'))throw new Error('This workflow slices one STL mesh; specify model in slice-config.json.');
  const model=resolve(ws,config.model),rel=relative(ws,model);if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('The mesh must be inside this workspace.');await access(model);
  const output=join(stage,'out');await mkdir(output);
  const args=['--slice','0','--arrange','1','--ensure-on-bed','--load-settings',settings.slice(0,2).join(';'),'--load-filaments',settings[2],'--outputdir',output,'--enable-arc-fitting=0','--post-process','',model];
  const result=spawnSync(bin,args,{cwd:stage,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});log=(result.stdout||'')+(result.stderr||'');
  if(result.error||result.status!==0)throw new Error(result.error?.message||'OrcaSlicer failed; inspect .harness/slice.log.');
  const files=(await readdir(output)).filter(name=>name.endsWith('.gcode'));
  if(files.length!==1)throw new Error('Expected exactly one freshly sliced G-code plate; got '+files.length+'.');
  const gcode=await readFile(join(output,files[0]),'utf8'),parsed=parseGcode(gcode);
  const data={...parsed,config,at:new Date().toISOString(),bytes:Buffer.byteLength(gcode)};
  const template=await readFile(new URL('preview.html',import.meta.url),'utf8'),app=await readFile(new URL('preview.js',import.meta.url),'utf8');
  const safe=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  await writeFile(join(stage,'preview.html'),template.replace('__CONFIG__',()=>safe).replace('/*APP*/',()=>app));
  await copyFile(join(output,files[0]),join(stage,'part.gcode'));await rename(join(stage,'part.gcode'),join(ws,'part.gcode'));await rename(join(stage,'preview.html'),join(ws,'preview.html'));
  await writeFile(join(meta,'slice.json'),JSON.stringify({config,stats:parsed.stats,layers:parsed.layers.length,moves:parsed.moves,warnings:parsed.warnings},null,2)+'\n');
  for(const [key,profile]of Object.entries(resolvedProfiles))await writeFile(join(meta,key+'-resolved.json'),JSON.stringify(profile,null,2)+'\n');
  await verdict(true,parsed.layers.length+' extrusion heights inspected · not print-tested',[{severity:'warning',kind:'safety',message:config.mode==='demo'?'Demo Prusa profile, not your printer. Do not print this file until printer, material, temperatures and geometry are reviewed.':'A sliced file is not a safety or printability certificate. Review machine-specific G-code in OrcaSlicer before printing.'},...parsed.warnings.map(message=>({severity:'info',kind:'preview',message}))]);
  console.log('ok   '+parsed.layers.length+' extrusion heights → part.gcode + preview.html');
}catch(error){await verdict(false,'Slice failed',[{severity:'error',kind:'slice',message:error.message}]);console.error(error.message);process.exitCode=1;}
finally{await writeFile(join(meta,'slice.log'),log);if(stage)await rm(stage,{recursive:true,force:true});}
