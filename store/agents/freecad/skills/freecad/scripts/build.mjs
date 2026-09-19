import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function findExecutable(){
  const candidates=[process.env.FREECAD_BIN,process.env.FREECAD_TOOLCHAIN&&join(process.env.FREECAD_TOOLCHAIN,'freecad-cli'),'freecadcmd','FreeCADCmd','/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd','/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd'];
  for(const candidate of candidates.filter(Boolean))for(const file of candidate.includes('/')?[candidate]:(process.env.PATH||'').split(delimiter).map(dir=>join(dir,candidate))){
    try{await access(file,constants.X_OK);return file;}catch{}
  }
  throw new Error('FreeCADCmd not found. Set FREECAD_BIN or run harness dsh doctor autonomous/freecad.');
}
export async function build(workspace,{bin}={}){
  const state=join(workspace,'.harness');await mkdir(state,{recursive:true});
  const atomic=async(path,value)=>{const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,value);await rename(temporary,path);};
  const verdict=value=>atomic(join(state,'verdict.json'),JSON.stringify({spec:1,...value,updatedAt:new Date().toISOString()},null,2)+'\n');
  let temporary;
  try{
    await verdict({ready:false,summary:'Building and reimporting the STEP assembly',findings:[],artifact:null});
    const executable=bin||await findExecutable();
    await access(join(workspace,'part.FCMacro'));
    temporary=await mkdtemp(join(state,'freecad-'));
    const runner=fileURLToPath(new URL('runner.py',import.meta.url));
    const result=spawnSync(executable,[runner],{cwd:workspace,env:{...process.env,HARNESS_WORKSPACE:workspace,HARNESS_BUILD_DIR:temporary},encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
    await atomic(join(state,'build.log'),(result.stdout||'')+(result.stderr||''));
    if(result.error||result.status!==0)throw new Error('FreeCAD failed: '+(result.error?.message||'exit '+result.status)+'. See .harness/build.log.');
    const report=JSON.parse(await readFile(join(temporary,'geometry.json'),'utf8'));
    const step=await readFile(join(temporary,'part.step'));
    if(!report.valid||!report.closed||report.solids<1||report.volumeMM3<=0||!step.toString('utf8').startsWith('ISO-10303-21;'))throw new Error('Fresh STEP verification failed.');
    const files=new Map([['part.step',step]]);
    for(const name of ['part.stl','part.FCStd']){
      try{const bytes=await readFile(join(temporary,name));if(!bytes.length)throw new Error(name+' is empty');files.set(name,bytes);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    for(const[name,bytes]of files)await atomic(join(workspace,name),bytes);
    await atomic(join(state,'geometry.json'),JSON.stringify(report,null,2)+'\n');
    await verdict({ready:true,summary:report.solids+' closed solids · STEP reimport verified',findings:[{severity:'info',kind:'manufacturing',message:'Geometry checks do not certify wall thickness, tolerances or strength. Review the design for its intended manufacturing process.'}],artifact:'part.step'});
    return report;
  }catch(error){await verdict({ready:false,summary:'FreeCAD build failed',findings:[{severity:'error',kind:'build',message:error.message}],artifact:null});throw error;}
  finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(await build(resolve(process.env.HARNESS_WORKSPACE||process.cwd())));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
