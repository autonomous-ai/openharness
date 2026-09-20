import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function findExecutable(){
  const candidates=[process.env.FREECAD_BIN,process.env.FREECAD_TOOLCHAIN&&join(process.env.FREECAD_TOOLCHAIN,'freecad-cli'),'freecadcmd','FreeCADCmd','/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd','/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd'];
  for(const candidate of candidates.filter(Boolean))for(const file of candidate.includes('/')?[candidate]:(process.env.PATH||'').split(delimiter).map(dir=>join(dir,candidate))){
    try{await access(file,constants.X_OK);return file;}catch{}
  }
  throw new Error('FreeCADCmd not found. Set FREECAD_BIN or run harness dsh doctor autonomous/freecad.');
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function publish(workspace, state, stage, names) {
  const history = join(state, 'history', basename(stage));
  await mkdir(history, {recursive:true});
  const saved = [], installed = [];
  try {
    if (await exists(join(state, 'geometry.json'))) await writeFile(join(history, 'geometry.json'), await readFile(join(state, 'geometry.json')));
    for (const name of names) {
      const destination = join(workspace, name);
      if (await exists(destination)) { await rename(destination, join(history, name)); saved.push(name); }
      await rename(join(stage, name), destination); installed.push(name);
    }
    return history;
  } catch (error) {
    const failures = [];
    for (const name of installed.reverse()) {
      try { await rename(join(workspace, name), join(stage, name)); } catch (failure) { failures.push(failure.message); }
    }
    for (const name of saved.reverse()) {
      try { await rename(join(history, name), join(workspace, name)); } catch (failure) { failures.push(failure.message); }
    }
    if (failures.length) throw new Error(`Publication failed; previous files are retained in ${history}. Restore errors: ${failures.join('; ')}`);
    throw error;
  }
}

export async function build(workspace,{bin}={}){
  workspace = resolve(workspace);
  const state=join(workspace,'.harness');await mkdir(state,{recursive:true});
  const lock = join(state, 'freecad-build.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another FreeCAD build owns .harness/freecad-build.lock. If a build crashed, confirm it has stopped before removing that lock directory.');
    throw error;
  }
  const atomic=async(path,value)=>{const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,value);await rename(temporary,path);};
  const verdict=value=>atomic(join(state,'verdict.json'),JSON.stringify({spec:1,...value,updatedAt:new Date().toISOString()},null,2)+'\n');
  let temporary, candidate = false, failedChecks = [];
  try{
    await writeFile(join(lock, 'owner.json'), JSON.stringify({pid:process.pid, startedAt:new Date().toISOString()}));
    await verdict({ready:false,summary:'Building the native project, measuring requirements and preparing the handoff',findings:[],artifact:null});
    const executable=bin||await findExecutable();
    await access(join(workspace,'part.FCMacro'));
    temporary=await mkdtemp(join(state,'freecad-'));
    const runner=fileURLToPath(new URL('runner.py',import.meta.url));
    const result=spawnSync(executable,['--user-cfg',join(temporary,'user.cfg'),'--system-cfg',join(temporary,'system.cfg'),runner],{cwd:workspace,env:{...process.env,HARNESS_WORKSPACE:workspace,HARNESS_BUILD_DIR:temporary},encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});
    await atomic(join(state,'build.log'),(result.stdout||'')+(result.stderr||''));
    if(result.error||result.status!==0)throw new Error('FreeCAD failed: '+(result.error?.message||'exit '+result.status)+'. See .harness/build.log.');
    let report;
    try { report=JSON.parse(await readFile(join(temporary,'geometry.json'),'utf8')); }
    catch { throw new Error('FreeCAD did not produce a fresh geometry receipt. See .harness/build.log for the source or requirement error.'); }
    const step=await readFile(join(temporary,'part.step'));
    if(!report.valid||!report.closed||report.solids<1||report.volumeMM3<=0||!step.toString('utf8').startsWith('ISO-10303-21;'))throw new Error('Fresh STEP verification failed.');
    const files=['part.step'];
    for(const name of ['part.stl','part.FCStd']){
      try{const bytes=await readFile(join(temporary,name));if(!bytes.length)throw new Error(name+' is empty');files.push(name);}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if (report.designChecked === true) {
      if (!report.sources || !Array.isArray(report.checks) || !report.checks.length || !Array.isArray(report.parts) || !report.parts.length) throw new Error('The design receipt is incomplete.');
      const root = await realpath(workspace);
      for (const [name, digest] of Object.entries(report.sources)) {
        const path = await realpath(resolve(workspace, name));
        if (!path.startsWith(root + sep) || createHash('sha256').update(await readFile(path)).digest('hex') !== digest) throw new Error('Source changed during the build; rebuild the current saved project: ' + name);
      }
      failedChecks = report.checks.filter(check => check.passed !== true);
      if (report.requirementsPassed !== true || failedChecks.length) {
        await atomic(join(state,'failed-design.json'),JSON.stringify(report,null,2)+'\n');
        await atomic(join(workspace,'candidate.step'),step); candidate = true;
        throw new Error(`${failedChecks.length} design requirement(s) failed. Inspect candidate.step and .harness/failed-design.json; the last successful handoff is unchanged.`);
      }
      for (const name of ['part.FCStd','part.stl','handoff/project.zip','handoff/index.html','handoff/checks.json']) {
        if (!(await readFile(join(temporary,name))).length) throw new Error('The handoff is missing '+name);
      }
      files.push('handoff');
    }
    const previous = await publish(workspace, state, temporary, files);
    report.previousArtifacts = previous;
    await atomic(join(state,'geometry.json'),JSON.stringify(report,null,2)+'\n');
    const ready = report.designChecked === true && report.requirementsPassed === true;
    await verdict({ready,summary:ready?`${report.parts.length} parts · ${report.checks.length} design checks passed · portable handoff ready`:'Geometry exported; add design.json to check the job requirements and prepare a portable handoff',findings:[{severity:ready?'info':'warning',kind:ready?'manufacturing':'requirements',message:ready?'Open handoff/index.html for parts, measured requirements and the editable project ZIP. Geometry checks do not certify strength, process suitability or physical fit.':'Legacy geometry-only build. Keep the preview, then capture the actual brief and measurable requirements in design.json.'}],artifact:'part.step'});
    return report;
  }catch(error){await verdict({ready:false,summary:failedChecks.length?'Design requirements failed':'FreeCAD build failed',findings:[{severity:'error',kind:'build',message:error.message},...failedChecks.map(check=>({severity:'error',kind:'requirement',message:check.id+': '+check.reason}))],artifact:candidate?'candidate.step':null});throw error;}
  finally{if(temporary)await rm(temporary,{recursive:true,force:true});await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await build(resolve(process.argv[2]||process.env.HARNESS_WORKSPACE||process.cwd()));console.log(report.designChecked?`${report.parts.length} parts · ${report.checks.length} measured requirements · handoff/index.html`:'Geometry rendered; design.json is needed to verify the user’s requirements.');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
