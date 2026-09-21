import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../skills/openscad/scripts/build.mjs';
import {Native} from '../skills/openscad/scripts/native.mjs';
import {fakeCompiler} from './fixture.mjs';
test('legacy transport exports fresh geometry but cannot claim checked readiness; failures preserve it',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'openscad-transport-'));
  try{
    await writeFile(join(workspace,'model.scad'),'cube(1);');
    let bin=await fakeCompiler(workspace);
    const report=await build(workspace,{bin});assert.equal(report.watertight,true);assert.equal(report.checked,false);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/verdict.json'))).ready,false);
    const saved=await readFile(join(workspace,'part.stl'));
    for(const body of ['process.exit(1);','process.exit(0);','writeFileSync(a[a.indexOf("-o")+1],"");process.exit(0);','console.error("WARNING: unknown module");process.exit(1);']){
      bin=await fakeCompiler(workspace,body);await assert.rejects(()=>build(workspace,{bin}));
      const verdict=JSON.parse(await readFile(join(workspace,'.harness/verdict.json')));
      assert.equal(verdict.ready,false);assert.equal(verdict.artifact,null);
      assert.deepEqual(await readFile(join(workspace,'part.stl')),saved);
    }
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('empty-query transport accepts only the exact native empty condition without diagnostics',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'openscad-empty-'));
  try{
    const empty='console.error("Current top level object is empty.");process.exit(1);';
    let bin=await fakeCompiler(workspace,empty);
    assert.equal((await new Native(bin,workspace).render('empty','cube(0);',{emptyAllowed:true})).empty,true);
    for(const diagnostic of ['WARNING: Ignoring unknown module','ERROR: Assertion failed']){
      bin=await fakeCompiler(workspace,'console.error('+JSON.stringify(diagnostic)+');'+empty);
      await assert.rejects(()=>new Native(bin,workspace).render('bad','bad();',{emptyAllowed:true}),/diagnostic/);
    }
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('a build lock leaves the owner verdict alone; source symlinks fail without exporting',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'openscad-lock-'));
  try{
    await mkdir(join(workspace,'.harness','openscad-build.lock'),{recursive:true});
    const verdict='{"ready":false,"summary":"Owned by another build"}';
    await writeFile(join(workspace,'.harness/verdict.json'),verdict);
    await assert.rejects(()=>build(workspace),/Another build/);
    assert.equal(await readFile(join(workspace,'.harness/verdict.json'),'utf8'),verdict);
    await rm(join(workspace,'.harness/openscad-build.lock'),{recursive:true});
    await writeFile(join(workspace,'external.scad'),'cube(1);');
    await symlink(join(workspace,'external.scad'),join(workspace,'model.scad'));
    const bin=await fakeCompiler(workspace);
    await assert.rejects(()=>build(workspace,{bin}),/symlinks/);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('source edits during compilation invalidate the candidate and preserve the previous STL',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'openscad-source-change-'));
  try{
    const model=join(workspace,'model.scad');await writeFile(model,'cube(1);');
    await build(workspace,{bin:await fakeCompiler(workspace)});
    const previous=await readFile(join(workspace,'part.stl'));
    const bin=await fakeCompiler(workspace,'writeFileSync('+JSON.stringify(model)+',"cube(2);");');
    await assert.rejects(()=>build(workspace,{bin}),/Source changed during build/);
    assert.deepEqual(await readFile(join(workspace,'part.stl')),previous);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/verdict.json'))).artifact,null);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
