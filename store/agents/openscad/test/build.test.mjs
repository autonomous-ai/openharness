import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../skills/openscad/scripts/build.mjs';
const tetra='solid tetra\n'+[[[0,0,0],[0,1,0],[1,0,0]],[[0,0,0],[1,0,0],[0,0,1]],[[0,0,0],[0,0,1],[0,1,0]],[[1,0,0],[0,1,0],[0,0,1]]].map(face=>'facet normal 0 0 0\nouter loop\n'+face.map(v=>'vertex '+v.join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid tetra\n';
test('only a fresh, inspected mesh can replace an older artifact or set ready',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'openscad-build-test-'));
  try{
    await writeFile(join(workspace,'model.scad'),'cube(1);');await writeFile(join(workspace,'fixture.stl'),tetra);
    const bin=join(workspace,'fake-openscad');
    await writeFile(bin,'#!/bin/sh\ncp fixture.stl "$2"\n',{mode:0o755});
    const report=await build(workspace,{bin});assert.equal(report.watertight,true);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/verdict.json'))).ready,true);
    const saved=await readFile(join(workspace,'part.stl'),'utf8');
    for(const command of ['exit 1','exit 0',': > "$2"']){
      await writeFile(bin,'#!/bin/sh\n'+command+'\n',{mode:0o755});
      await assert.rejects(()=>build(workspace,{bin}));
      const verdict=JSON.parse(await readFile(join(workspace,'.harness/verdict.json')));
      assert.equal(verdict.ready,false);assert.equal(verdict.artifact,null);
      assert.equal(await readFile(join(workspace,'part.stl'),'utf8'),saved);
    }
  }finally{await rm(workspace,{recursive:true,force:true});}
});
