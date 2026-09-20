import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,symlink,cp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateConfig,prepareModel,inspectPlan,planSettings,canonicalReopenSettings} from '../skills/orcaslicer/scripts/contract.mjs';
import {parseGcode} from '../skills/orcaslicer/scripts/gcode.mjs';
import {profileWithSources,unchangedProfiles} from '../skills/orcaslicer/scripts/profiles.mjs';
import {zip,unzip} from '../skills/orcaslicer/scripts/archive.mjs';
import {build} from '../skills/orcaslicer/scripts/build.mjs';
import {transaction} from '../skills/orcaslicer/scripts/files.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const config=()=>readFile(join(root,'template/slice-config.json'),'utf8').then(JSON.parse);
test('saved requirements are strict, bounded and independent of the STL',async()=>{
 const c=await config();validateConfig(c);
 for(const mutate of [
  c=>c.unrecognized=true,c=>c.machine.context='guessed',c=>c.sourceFiles.push('../secret'),
  c=>c.sourceFiles.push('model.stl'),c=>c.model.expectedSizeMM=[1,1],c=>c.model.scale=0,
  c=>c.machine.firmware='klipper',c=>c.plans[0].layerHeightMM=1,c=>c.plans[0].wallLoops=2.2,
  c=>c.selectedPlan='absent',c=>c.profiles.printer='../outside.json'
 ]){const broken=structuredClone(c);mutate(broken);assert.throws(()=>validateConfig(broken));}
 const bytes=await readFile(join(root,'template/model.stl')),model=prepareModel(bytes,c);assert.equal(model.mesh.watertight,true);
 assert.equal(model.mesh.shells.length,1);assert.ok(Math.abs(model.mesh.bounds.size[0]-87.8)<.01);
 c.model.expectedSizeMM[0]+=1;assert.throws(()=>prepareModel(bytes,c),/saved millimetre brief/);c.model.expectedSizeMM[0]-=1;
 c.machine.bedMM=[20,20,20];assert.throws(()=>prepareModel(bytes,c),/exceeds the declared bed/);
});
test('explicit rotation and scale are measured on the mesh passed to Orca',async()=>{
 const c=await config();c.model.rotationDegrees=[90,0,0];c.model.scale=.5;
 const {mesh}=prepareModel(await readFile(join(root,'template/model.stl')),c);
 for(const [i,want]of [43.9,9,29.6].entries())assert.ok(Math.abs(mesh.bounds.size[i]-want)<.01);
 assert.ok(mesh.bounds.min.every(v=>Math.abs(v)<.0001));
});
test('ZIP roundtrip is bounded and CRC checked; unsafe and duplicate entries fail',()=>{
 const bytes=zip([{name:'README.md',bytes:'Hello'},{name:'nested/model.stl',bytes:Buffer.from([1,2,3])}]);
 assert.equal(unzip(bytes).get('README.md').toString(),'Hello');
 const broken=Buffer.from(bytes);broken[40]^=1;assert.throws(()=>unzip(broken));
 assert.throws(()=>zip([{name:'../secret',bytes:''}]),/Unsafe/);
 assert.throws(()=>zip([{name:'a',bytes:''},{name:'A',bytes:''}]),/duplicate/);
 assert.throws(()=>unzip(bytes.subarray(0,-1)),/directory/);
});
test('profile credentials, leaf symlinks and edits during slicing fail without exposing secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-profile-guards-'));try{
  const file=join(dir,'profile.json');await writeFile(file,JSON.stringify({name:'my profile',type:'machine'}));
  const snapshot=await profileWithSources(file);await unchangedProfiles([snapshot]);
  await writeFile(file,JSON.stringify({name:'revised'}));await assert.rejects(unchangedProfiles([snapshot]),/changed/);
  await writeFile(file,JSON.stringify({name:'secret profile',printhost_apikey:'DO_NOT_SHOW'}));
  await assert.rejects(profileWithSources(file),error=>error.message.includes('credential')&&!error.message.includes('DO_NOT_SHOW'));
  await symlink(file,join(dir,'link.json'));await assert.rejects(profileWithSources(join(dir,'link.json')),/symlink/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('effective settings alone cannot mask wrong heater commands or a missing shutdown',async()=>{
 const c=await config(),p=c.plans[1],effective={...planSettings(p),curr_bed_type:c.machine.bedType,printer_model:c.machine.printerModel,gcode_flavor:c.machine.firmware,nozzle_diameter:['0.4'],printable_height:'210',filament_type:['PLA'],nozzle_temperature:['220'],nozzle_temperature_initial_layer:['220'],hot_plate_temp:['60'],hot_plate_temp_initial_layer:['60']};
 effective.printable_area=['0x0','250x0','250x210','0x210'];effective.bed_exclude_area=['0x0'];
 const configuration=Object.entries(effective).map(([k,v])=>'; '+k+' = '+(Array.isArray(v)?v.join(','):v)).join('\n');
 const fixture='G90\nM83\nM104 S220\nM140 S60\nG0 X10 Y10 Z.2 F6000\n;TYPE:Outer wall\nG1 X20 E1 F1200\nM104 S0\nM140 S0\n; total layer number: 1\n; estimated printing time (normal mode) = 1m 0s\n; total filament used [g] = 2\n; CONFIG_BLOCK_START\n'+configuration+'\n; CONFIG_BLOCK_END\n';
 const inspect=text=>inspectPlan(parseGcode(text),effective,c,p,{bounds:{size:[10,10,.2]}});
 assert.ok(inspect(fixture).every(c=>c.pass));
 assert.throws(()=>inspect(fixture.replace('M140 S60','M140 S35')),/heater commands/);
 assert.throws(()=>inspect(fixture.replace('M104 S0\n','')),/off after final/);
 assert.throws(()=>inspect(fixture.replace('M140 S0\n','M140 S0\nG1 E1\n')),/targets at extrusion|off after final/);
 assert.throws(()=>inspect(fixture.replace('G1 X20','G1 X300')),/inside bed/);
 const altered={...effective,layer_height:'0.28'};
 assert.throws(()=>inspectPlan(parseGcode(fixture),altered,c,p,{bounds:{size:[10,10,.2]}}),/Effective layer_height/);
});
test('native reopen normalization never ignores changed slicing or compatibility values',()=>{
 assert.deepEqual(canonicalReopenSettings({layer_height:'0.2'}),canonicalReopenSettings({layer_height:'0.2',upward_compatible_machine:[]}));
 assert.notDeepEqual(canonicalReopenSettings({layer_height:'0.2'}),canonicalReopenSettings({layer_height:'0.3'}));
 assert.notDeepEqual(canonicalReopenSettings({}),canonicalReopenSettings({upward_compatible_machine:['different printer']}));
});
test('bad briefs and locks do not replace the last successful handoff',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-failed-'));try{
  await cp(join(root,'template'),dir,{recursive:true});await writeFile(join(dir,'preview.html'),'previous successful artifact');
  const c=await config();c.model.path='../outside.stl';await writeFile(join(dir,'slice-config.json'),JSON.stringify(c));
  await assert.rejects(build(dir),/safe workspace-relative/);
  assert.equal(await readFile(join(dir,'preview.html'),'utf8'),'previous successful artifact');
  assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false);
  await mkdir(join(dir,'.harness/orca-build.lock'));
  await assert.rejects(transaction(dir,()=>assert.fail('must not enter')),/Another build owns/);
  assert.equal(await readFile(join(dir,'preview.html'),'utf8'),'previous successful artifact');
 }finally{await rm(dir,{recursive:true,force:true});}
});
