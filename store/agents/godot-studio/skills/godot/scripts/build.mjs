import {access,cp,mkdtemp,mkdir,readFile,writeFile,rename,rm,stat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
const ws=resolve(process.env.HARNESS_WORKSPACE||process.cwd()), meta=join(ws,'.harness');
await mkdir(meta,{recursive:true});
const verdict=async(ready,summary,findings=[])=>writeFile(join(meta,'verdict.json'),JSON.stringify({spec:1,ready,summary,findings,artifact:ready?'build/web/index.html':null,updatedAt:new Date().toISOString()},null,2)+'\n');
await verdict(false,'Checking gameplay and exporting Web…');
let stage,log='';
try{
  let bin=process.env.GODOT_BIN;
  if(!bin){const found=spawnSync('/bin/sh',['-c','command -v godot'],{encoding:'utf8'});bin=found.stdout.trim()||'/Applications/Godot.app/Contents/MacOS/Godot';}
  await access(bin,constants.X_OK).catch(()=>{throw new Error('Godot not found. Install Godot 4.3+ and matching Web templates, or set GODOT_BIN.');});
  stage=await mkdtemp(join(meta,'godot-'));
  const project=join(stage,'project'), output=join(stage,'web');
  await mkdir(project);
  const allowed=path=>!relative(ws,path).split(/[\\/]/).some(part=>['.harness','.godot','.git','build','node_modules'].includes(part));
  for(const entry of await readdir(ws))if(allowed(join(ws,entry)))await cp(join(ws,entry),join(project,entry),{recursive:true,filter:allowed});
  await mkdir(output);
  let presets=await readFile(join(project,'export_presets.cfg'),'utf8');
  if(process.env.GODOT_WEB_TEMPLATE){
    const template=resolve(process.env.GODOT_WEB_TEMPLATE);await access(template);
    presets=presets.replace(/^custom_template\/release=.*$/m,'custom_template/release='+JSON.stringify(template));
    await writeFile(join(project,'export_presets.cfg'),presets);
  }
  await access(join(project,'scripts/proof.gd')).catch(()=>{throw new Error('Add scripts/proof.gd with assertions and a proof.json receipt in HARNESS_BUILD_DIR.');});
  const run=(args)=>{
    const result=spawnSync(bin,['--headless','--path',project,...args],{env:{...process.env,HARNESS_BUILD_DIR:stage},encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
    log+='\n$ godot '+args.join(' ')+'\n'+(result.stdout||'')+(result.stderr||'');
    if(result.error||result.status!==0)throw new Error(result.error?.message||'Godot failed; inspect .harness/export.log.');
  };
  run(['--editor','--import']);
  run(['--script','res://scripts/proof.gd']);
  const proof=JSON.parse(await readFile(join(stage,'proof.json'),'utf8'));
  if(proof.passed!==true||!Array.isArray(proof.checks)||!proof.checks.length)throw new Error('Gameplay proof did not produce a passing receipt.');
  run(['--export-release','Web',join(output,'index.html')]);
  for(const name of ['index.html','index.js','index.pck','index.wasm'])if((await stat(join(output,name))).size===0)throw new Error('Empty export: '+name);
  const destination=join(ws,'build/web');await mkdir(join(ws,'build'),{recursive:true});
  // Preserve the previous export until a fresh proof and export both succeed.
  let previous=false;
  try{await rename(destination,join(stage,'previous'));previous=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await rename(output,destination);}catch(error){if(previous)await rename(join(stage,'previous'),destination);throw error;}
  await writeFile(join(meta,'gameplay-proof.json'),JSON.stringify(proof,null,2)+'\n');
  await writeFile(join(ws,'build-status.html'),'<!doctype html><meta charset="utf-8"><title>Godot export</title><h1>Gameplay assertions and Web export passed</h1><p>Browser playthrough is a separate check.</p><a href="build/web/index.html">Play the exported game</a>');
  await verdict(true,'Gameplay assertions and Web export passed',[{severity:'info',kind:'verification',message:'Headless game-state checks passed. Run browser proof and play through the exported build before claiming browser compatibility.'}]);
  console.log('ok   '+proof.checks.length+' gameplay checks; Web export → build/web/index.html');
}catch(error){await verdict(false,'Game build failed',[{severity:'error',kind:'build',message:error.message}]);console.error(error.message);process.exitCode=1;}
finally{await writeFile(join(meta,'export.log'),log);if(stage)await rm(stage,{recursive:true,force:true});}
