import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,cp,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from '../skills/openscad/scripts/build.mjs';
import {Native} from '../skills/openscad/scripts/native.mjs';
const bin=process.env.OPENSCAD_BIN,root=process.env.OPENSCAD_QA_ROOT||tmpdir();
const fixture=new URL('fixtures/bottles/',import.meta.url),template=new URL('../template/',import.meta.url);
async function workspace(name,source){
  await mkdir(root,{recursive:true});
  const target=await mkdtemp(join(root,'openscad-'+name+'-'));
  await cp(source,target,{recursive:true});console.log('Native QA workspace: '+target);return target;
}
const readJSON=async path=>JSON.parse(await readFile(path,'utf8'));
const saveJSON=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
test('native drawer family, substantive revision, and failed clearance/material/bed revisions preserve good downloads',{skip:!bin},async()=>{
  const dir=await workspace('drawer',template),designPath=join(dir,'design.json'),modelPath=join(dir,'model.scad');
  await writeFile(join(dir,'private-notes.txt'),'This undeclared file must not enter the portable project.');
  const first=await build(dir,{bin});
  assert.equal(first.variants.length,3);assert.equal(first.checks.length,24);assert.ok(first.checks.every(c=>c.passed));
  const firstRevision=first.sourceRevision,brief=await readJSON(designPath);
  brief.parameters.depth.value=104;brief.parameters.columns.value=4;
  brief.title='Drawer Grid — four compartments';brief.brief='Revise to four compartments, 104 mm deep; keep the saved floor and wall thicknesses.';
  await saveJSON(designPath,brief);
  const revision=await build(dir,{bin});
  assert.notEqual(revision.sourceRevision,firstRevision);
  assert.ok(revision.variants.every(v=>v.parts[0].mesh.bounds.size[1]===104));
  const saved=await readFile(join(dir,'handoff/project.zip')),goodModel=await readFile(modelPath,'utf8');
  await writeFile(modelPath,goodModel.replace(', wall, floor])',', wall, floor/2])'));
  await assert.rejects(()=>build(dir,{bin}),/floor/);
  assert.deepEqual(await readFile(join(dir,'handoff/project.zip')),saved);
  assert.equal((await readJSON(join(dir,'.harness/verdict.json'))).ready,false);
  assert.ok((await readJSON(join(dir,'.harness/failed-mesh.json'))).checks.some(c=>c.id.endsWith('-floor')&&!c.passed));
  await writeFile(modelPath,goodModel.replace('cube([width, depth, height]);','cube([width, depth, height]);').replace('module part(', 'module geometry(').replace('part("tray");','')+
    '\nmodule part(id,width=180,depth=96,height=40,wall=2.4,floor=2.4,columns=3){union(){geometry(id,width,depth,height,wall,floor,columns);translate([wall,wall,floor])cube([2,2,2]);}}\n');
  await assert.rejects(()=>build(dir,{bin}),/pockets/);
  assert.deepEqual(await readFile(join(dir,'handoff/project.zip')),saved);
  await writeFile(modelPath,goodModel);
  const tooSmall=structuredClone(brief);tooSmall.process.bedMM[0]=140;tooSmall.variants=[brief.variants[0]];tooSmall.preview.variant='compact';
  await saveJSON(designPath,tooSmall);
  await assert.rejects(()=>build(dir,{bin}),/bed/);
  assert.deepEqual(await readFile(join(dir,'handoff/project.zip')),saved);
  await saveJSON(designPath,brief);
  const restored=await build(dir,{bin});assert.equal(restored.sourceRevision,revision.sourceRevision);
  const listing=spawnSync('/usr/bin/unzip',['-Z1',join(dir,'handoff/project.zip')],{encoding:'utf8'});
  assert.equal(listing.status,0);assert.ok(!listing.stdout.includes('private-notes'));
  const extracted=await workspace('portable',new URL('fixtures/empty/',import.meta.url));
  const unzip=spawnSync('/usr/bin/unzip',['-q',join(dir,'handoff/project.zip'),'-d',extracted],{encoding:'utf8'});
  assert.equal(unzip.status,0,unzip.stderr);
  const rebuilt=spawnSync(process.execPath,['rebuild/build.mjs','.'],{cwd:extracted,env:{...process.env,OPENSCAD_BIN:bin},encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});
  assert.equal(rebuilt.status,0,rebuilt.stderr);
  const proof=await readJSON(join(extracted,'.harness/mesh.json'));
  assert.equal(proof.sourceRevision,restored.sourceRevision);assert.equal(proof.checks.length,24);
  assert.deepEqual(proof.variants.map(v=>v.parts.map(p=>p.printMesh.bounds)),restored.variants.map(v=>v.parts.map(p=>p.printMesh.bounds)));
  await access(join(extracted,'preview.scad'));
});
test('native independent bottle rack and rotated negative-coordinate fit ring',{skip:!bin},async()=>{
  const dir=await workspace('bottles',fixture),report=await build(dir,{bin});
  assert.equal(report.checks.length,39);assert.ok(report.checks.every(c=>c.passed));
  for(const variant of report.variants){
    const ring=variant.parts.find(p=>p.id==='gauge');
    assert.ok(ring.mesh.bounds.min[0]<0);assert.deepEqual(ring.printMesh.bounds.min,[0,0,0]);
    assert.deepEqual(ring.printRotation,[180,0,0]);assert.equal(variant.parts.length,2);
  }
  const designPath=join(dir,'design.json'),brief=await readJSON(designPath);
  const saved=await readFile(join(dir,'handoff/project.zip'));
  const bad=structuredClone(brief);bad.variants=[bad.variants[1]];
  bad.checks.find(c=>c.id==='separate-layout').translation=[20,20,0];
  await saveJSON(designPath,bad);
  await assert.rejects(()=>build(dir,{bin}),/separate-layout/);
  assert.deepEqual(await readFile(join(dir,'handoff/project.zip')),saved);
  await saveJSON(designPath,brief);
  await build(dir,{bin});
});
test('native empty assertions/unknown modules cannot pass a query; undeclared inputs and random geometry are rejected',{skip:!bin},async()=>{
  const dir=await workspace('guards',template),query=join(dir,'query');await mkdir(query);
  for(const code of ['missing_module();','assert(false,"Deliberate failure");']){
    await assert.rejects(()=>new Native(bin,query).render('invalid',code,{emptyAllowed:true}),/diagnostic/);
  }
  assert.equal((await new Native(bin,query).render('empty','intersection(){cube(1);translate([2,0,0])cube(1);}',{emptyAllowed:true})).empty,true);
  const brief=await readJSON(join(dir,'design.json'));brief.variants=[brief.variants[1]];await saveJSON(join(dir,'design.json'),brief);
  const original=await readFile(join(dir,'model.scad'),'utf8');
  const outside=join(dir,'external.scad');await writeFile(outside,'module external(){cube(1);}\n');
  await writeFile(join(dir,'model.scad'),'use <'+outside+'>\n'+original.replace('cube([width, depth, height]);','union(){cube([width, depth, height]);external();}'));
  await assert.rejects(()=>build(dir,{bin}),/undeclared dependency/);
  await writeFile(join(dir,'model.scad'),original.replace('cube([width, depth, height]);','cube([width+rands(1,10,1)[0], depth, height]);'));
  await assert.rejects(()=>build(dir,{bin}),/repeated source exports disagree/);
  await writeFile(join(dir,'geometry.scad'),original);
  await writeFile(join(dir,'model.scad'),'include <geometry.scad>\n');
  brief.sourceFiles.push('geometry.scad');await saveJSON(join(dir,'design.json'),brief);
  const portableInput=await build(dir,{bin});
  assert.equal(portableInput.checks.length,8);assert.ok(portableInput.sources['geometry.scad']);
});
test('native legacy Ripple remains editable geometry, not a falsely checked manufacturing handoff',{skip:!bin},async()=>{
  const dir=await workspace('legacy',new URL('fixtures/empty/',import.meta.url));
  await cp(new URL('fixtures/ripple.scad',import.meta.url),join(dir,'model.scad'));
  const report=await build(dir,{bin});
  assert.equal(report.checked,false);assert.equal(report.watertight,true);
  const verdict=await readJSON(join(dir,'.harness/verdict.json'));assert.equal(verdict.ready,false);assert.equal(verdict.artifact,'part.stl');
});
