import {access,readFile,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
export async function engine(){
 let bin=process.env.ORCA_BIN;
 if(!bin)bin=spawnSync('/bin/sh',['-c','command -v orca-slicer || command -v orcaslicer'],{encoding:'utf8'}).stdout?.trim()||'/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer';
 await access(bin,constants.X_OK).catch(()=>{throw new Error('Install OrcaSlicer 2.4.2 or set ORCA_BIN. No slicing outputs were replaced.');});
 bin=await realpath(bin);return {bin,profiles:process.env.ORCA_PROFILES_DIR||resolve(dirname(bin),'../Resources/profiles')};
}
export function runNative(bin,args,cwd){
 const result=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024,env:{...process.env}});
 const log=(result.stdout||'')+(result.stderr||'');
 if(result.error||result.status!==0){const error=new Error('OrcaSlicer failed ('+(result.error?.message||result.signal||result.status)+'). Inspect .harness/slice.log.');error.nativeLog=log;throw error;}
 return log;
}
export async function oneFile(dir,extension){
 const names=(await readdir(dir)).filter(n=>n.toLowerCase().endsWith(extension));
 if(names.length!==1)throw new Error('Expected exactly one fresh '+extension+' output, got '+names.length+'.');
 return {name:names[0],bytes:await readFile(join(dir,names[0]))};
}
