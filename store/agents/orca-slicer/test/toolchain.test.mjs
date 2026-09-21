// Transport fixtures test failure handling, not the native slicer's correctness.
// Successful readiness is covered only by the opt-in real native suite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,cp,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveProfile} from '../skills/orcaslicer/scripts/profiles.mjs';
test('missing engine and an empty successful CLI cannot replace prior results',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-transport-'));try{
  await cp(join(root,'template'),dir,{recursive:true});await writeFile(join(dir,'preview.html'),'last good');
  const c=JSON.parse(await readFile(join(dir,'slice-config.json')));
  c.profiles={source:'workspace',printer:'printer.json',process:'process.json',filament:'filament.json'};
  c.sourceFiles.push('printer.json','process.json','filament.json');
  await writeFile(join(dir,'slice-config.json'),JSON.stringify(c));
  await writeFile(join(dir,'printer.json'),JSON.stringify({name:'fixture printer',type:'machine',printer_model:c.machine.printerModel,gcode_flavor:'marlin',nozzle_diameter:['0.4'],printable_area:['0x0','250x0','250x210','0x210'],printable_height:'210'}));
  await writeFile(join(dir,'process.json'),JSON.stringify({name:'fixture process',type:'process'}));
  await writeFile(join(dir,'filament.json'),JSON.stringify({name:'fixture filament',type:'filament',filament_type:['PLA']}));
  const run=bin=>spawnSync(process.execPath,[join(root,'skills/orcaslicer/scripts/build.mjs')],{cwd:dir,encoding:'utf8',env:{...process.env,HARNESS_WORKSPACE:dir,ORCA_BIN:bin}});
  let result=run(join(dir,'not-installed'));assert.equal(result.status,1);assert.match(result.stderr,/Install OrcaSlicer/);
  const stub=join(dir,'fixture.sh');await writeFile(stub,'#!/bin/sh\nexit 0\n');await chmod(stub,0o755);
  result=run(stub);assert.equal(result.status,1);assert.match(result.stderr,/exactly one fresh .gcode/);
  assert.equal(await readFile(join(dir,'preview.html'),'utf8'),'last good');assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
const root=fileURLToPath(new URL('..',import.meta.url));
test('profiles resolve sibling inheritance; missing and cyclic parents fail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-profiles-'));try{
 await writeFile(join(dir,'base.json'),JSON.stringify({name:'base',temperature:['220'],density:['1.24']}));
 await writeFile(join(dir,'child.json'),JSON.stringify({name:'child',inherits:'base',temperature:['210']}));
 assert.deepEqual(await resolveProfile(join(dir,'child.json')),{name:'child',temperature:['210'],density:['1.24'],instantiation:'true'});
 await writeFile(join(dir,'base.json'),JSON.stringify({name:'base',inherits:'child'}));
 await assert.rejects(resolveProfile(join(dir,'child.json')),/Cyclic/);
 await writeFile(join(dir,'child.json'),JSON.stringify({name:'child',inherits:'missing'}));
 await assert.rejects(resolveProfile(join(dir,'child.json')),/Cannot resolve/);
 await writeFile(join(dir,'child.json'),JSON.stringify({name:'child',inherits:'../escape'}));
 await assert.rejects(resolveProfile(join(dir,'child.json')),/sibling/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy demo configs cannot receive new checked readiness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-legacy-'));try{
  await cp(join(root,'template'),dir,{recursive:true});
  await writeFile(join(dir,'slice-config.json'),JSON.stringify({mode:'demo',model:'model.stl'}));
  const result=spawnSync(process.execPath,[join(root,'skills/orcaslicer/scripts/build.mjs')],{cwd:dir,env:{...process.env,HARNESS_WORKSPACE:dir},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/spec: 1 slicing brief/);
  assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
