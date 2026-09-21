// Opt-in actual OrcaSlicer tests. Without ORCA_BIN these SKIP, never claim a slice.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,cp,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from '../skills/orcaslicer/scripts/build.mjs';
import {engine,runNative,oneFile} from '../skills/orcaslicer/scripts/native.mjs';
import {resolveProfile} from '../skills/orcaslicer/scripts/profiles.mjs';
import {parseGcode} from '../skills/orcaslicer/scripts/gcode.mjs';
import {canonicalReopenSettings} from '../skills/orcaslicer/scripts/contract.mjs';
import {unzip} from '../skills/orcaslicer/scripts/archive.mjs';
import {sha} from '../skills/orcaslicer/scripts/files.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),enabled=Boolean(process.env.ORCA_BIN);
const workspace=async name=>{
 const parent=process.env.ORCA_EVIDENCE_DIR||tmpdir();await mkdir(parent,{recursive:true});return mkdtemp(join(parent,name+'-'));
};
test('native rack: three checked plans, standalone ZIP rebuild and independent project re-slice',{skip:!enabled,timeout:600000},async()=>{
 const dir=await workspace('orca-rack');await cp(join(root,'template'),dir,{recursive:true});
 await writeFile(join(dir,'private-note.txt'),'not declared, never included');
 const report=await build(dir);assert.equal(report.plans.length,3);
 assert.ok(report.plans.every(p=>p.checks.every(c=>c.pass)));
 assert.ok(report.plans[0].stats.timeSeconds<report.plans[1].stats.timeSeconds);
 assert.ok(report.plans[1].stats.timeSeconds<report.plans[2].stats.timeSeconds);
 const members=unzip(await readFile(join(dir,'handoff/project.zip')));assert.ok(!members.has('private-note.txt'));
 const portable=await workspace('orca-portable');
 for(const [name,bytes]of members){await mkdir(dirname(join(portable,name)),{recursive:true});await writeFile(join(portable,name),bytes);}
 const rebuilt=spawnSync(process.execPath,[join(portable,'rebuild/build.mjs')],{cwd:portable,encoding:'utf8',env:{...process.env,HARNESS_WORKSPACE:portable},timeout:300000,maxBuffer:4*1024*1024});
 assert.equal(rebuilt.status,0,rebuilt.stderr);
 const second=JSON.parse(await readFile(join(portable,'handoff/report.json')));assert.equal(second.revision,report.revision);
 for(const [i,p]of report.plans.entries()){assert.equal(second.plans[i].layers,p.layers);assert.ok(Math.abs(second.plans[i].stats.filamentGrams-p.stats.filamentGrams)<.1);}
 const selected=report.plans.find(p=>p.id===report.selectedPlan),native=await engine(),recheck=await workspace('orca-project-reslice');await mkdir(join(recheck,'out'));
 const log=runNative(native.bin,['--datadir',join(recheck,'appdata'),'--debug','2','--slice','0','--arrange','0','--orient','0','--ensure-on-bed','--outputdir',join(recheck,'out'),'--export-settings',join(recheck,'effective.json'),'--enable-arc-fitting=0','--post-process','',join(dir,selected.project)],recheck);
 await writeFile(join(recheck,'native.log'),log);
 const actual=parseGcode((await oneFile(join(recheck,'out'),'.gcode')).bytes.toString());
 assert.deepEqual(canonicalReopenSettings(JSON.parse(await readFile(join(recheck,'effective.json')))),canonicalReopenSettings(selected.effective));
 assert.equal(actual.modelLayers,selected.layers);
 for(const side of ['min','max'])for(let axis=0;axis<3;axis++)assert.ok(Math.abs(actual.modelBounds[side][axis]-selected.bounds[side][axis])<.03);
 assert.ok(Math.abs(actual.stats.filamentGrams-selected.stats.filamentGrams)<Math.max(.1,selected.stats.filamentGrams*.01));
 assert.ok(Math.abs(actual.stats.timeSeconds-selected.stats.timeSeconds)<Math.max(2,selected.stats.timeSeconds*.01));
 await writeFile(join(dir,'acceptance.json'),JSON.stringify({workspace:dir,portable,recheck,sourceRevision:report.revision,plans:report.plans.map(p=>({id:p.id,stats:p.stats,layers:p.layers,checks:p.checks.length})),reslicedStats:actual.stats},null,2));
 console.log('Native rack evidence: '+dir);
});
test('native spacer: user-exported profiles, rotated mesh, substantive revision and failed candidate preservation',{skip:!enabled,timeout:480000},async()=>{
 const dir=await workspace('orca-spacer'),native=await engine();await cp(join(root,'template'),dir,{recursive:true});
 await cp(join(root,'test/fixtures/spacer.stl'),join(dir,'model.stl'));await cp(join(root,'test/fixtures/spacer.scad'),join(dir,'model.scad'));
 const c=JSON.parse(await readFile(join(dir,'slice-config.json')));c.title='Mounting spacer · A dimensional trial';c.brief='Prepare a 24 mm outside / 8.4 mm bore / 6 mm high spacer trial; compare two slicing plans and preserve editable native projects. No load or fit rating.';
 c.assumptions='Software-only example Prusa MK3S / 0.4 mm nozzle / PLA / High Temp Plate, not a known user printer. The 8.4 mm bore is a CAD dimension, not a measured physical fit. No load rating or physical print validation.';
 await writeFile(join(dir,'print-config.md'),'# Spacer trial\n\n24 mm outside diameter, 8.4 mm bore, 6 mm high. Rotate X by 180 degrees, then compare two plans. Software-only example machine; no physical fit or load rating. Revise the Everyday plan to four walls at 0.16 mm and verify the native output changes.\n');
 c.model={path:'model.stl',expectedSizeMM:[24,24,6],toleranceMM:.03,rotationDegrees:[180,0,0],scale:1};
 c.plans=c.plans.slice(0,2);c.selectedPlan='everyday';c.profiles.source='workspace';
 for(const key of ['printer','process','filament']){const p=await resolveProfile(join(native.profiles,c.profiles[key]));c.profiles[key]='profiles/'+key+'.json';c.sourceFiles.push(c.profiles[key]);await mkdir(join(dir,'profiles'),{recursive:true});await writeFile(join(dir,c.profiles[key]),JSON.stringify(p,null,2));}
 await writeFile(join(dir,'slice-config.json'),JSON.stringify(c,null,2));const first=await build(dir);
 c.plans[1].wallLoops=4;c.plans[1].layerHeightMM=.16;c.plans[1].topLayers=5;c.plans[1].description='Four walls at 0.16 mm; compare the measured slicing tradeoff, not assumed strength.';
 await writeFile(join(dir,'slice-config.json'),JSON.stringify(c,null,2));const second=await build(dir);
 assert.notEqual(first.revision,second.revision);assert.equal(second.plans[1].effective.wall_loops,'4');assert.equal(second.plans[1].effective.layer_height,'0.16');
 assert.notEqual(first.plans[1].layers,second.plans[1].layers);
 const zipHash=sha(await readFile(join(dir,'handoff/project.zip'))),html=await readFile(join(dir,'preview.html'),'utf8');
 for(const [name,mutate,pattern]of [
  ['wrong-nozzle',c=>c.machine.nozzleMM=.6,/nozzle/],
  ['wrong-size',c=>c.model.expectedSizeMM[0]=240,/saved millimetre brief/],
  ['too-small-bed',c=>c.machine.bedMM=[10,10,10],/bed/],
  ['wrong-temperature',c=>c.machine.bedTemperatureRange=[20,40],/Profile hot_plate_temp/],
  ['time-budget',c=>c.limits.maxTimeSeconds=1,/Time budget/]
 ]){
  const bad=structuredClone(c);mutate(bad);await writeFile(join(dir,'slice-config.json'),JSON.stringify(bad));
  await assert.rejects(build(dir),pattern);assert.equal(sha(await readFile(join(dir,'handoff/project.zip'))),zipHash,name);assert.equal(await readFile(join(dir,'preview.html'),'utf8'),html,name);
  assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false,name);
 }
 await writeFile(join(dir,'slice-config.json'),JSON.stringify(c,null,2));await build(dir);
 await writeFile(join(dir,'acceptance.json'),JSON.stringify({workspace:dir,before:first.plans.map(p=>({id:p.id,layers:p.layers,stats:p.stats})),after:second.plans.map(p=>({id:p.id,layers:p.layers,stats:p.stats})),negativeCandidates:5,preservedZipSha256:zipHash},null,2));
 console.log('Native spacer evidence: '+dir);
});
test('native source edit while slicing cannot publish checked artifacts',{skip:!enabled,timeout:240000},async()=>{
 const dir=await workspace('orca-race');await cp(join(root,'template'),dir,{recursive:true});
 const c=JSON.parse(await readFile(join(dir,'slice-config.json')));c.plans=[c.plans[0]];c.selectedPlan='draft';await writeFile(join(dir,'slice-config.json'),JSON.stringify(c));
 const real=process.env.ORCA_BIN,wrapper=join(dir,'orca-fixture.sh');
 await writeFile(wrapper,'#!/bin/sh\n"$REAL_ORCA" "$@"\nresult=$?\nprintf "\\nchanged while slicing\\n" >> "$RACE_NOTE"\nexit "$result"\n');await chmod(wrapper,0o755);
 const result=spawnSync(process.execPath,[join(root,'skills/orcaslicer/scripts/build.mjs')],{cwd:dir,encoding:'utf8',timeout:180000,env:{...process.env,ORCA_BIN:wrapper,REAL_ORCA:real,RACE_NOTE:join(dir,'print-config.md'),ORCA_PROFILES_DIR:(await engine()).profiles,HARNESS_WORKSPACE:dir}});
 assert.equal(result.status,1);assert.match(result.stderr,/Source changed during build/);
 assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false);
 console.log('Native source-race evidence: '+dir);
});
