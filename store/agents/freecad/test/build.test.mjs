import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../skills/freecad/scripts/build.mjs';
test('a successful CLI exit with no fresh STEP receipt cannot reuse an old artifact',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'freecad-build-test-'));
  try{
    await writeFile(join(workspace,'part.FCMacro'),'# macro');
    const bin=join(workspace,'fake-freecad');
    await writeFile(bin,'#!/bin/sh\nprintf \'ISO-10303-21;\\nEND-ISO-10303-21;\\n\' > "$HARNESS_BUILD_DIR/part.step"\nprintf \'{"valid":true,"closed":true,"solids":1,"volumeMM3":1}\' > "$HARNESS_BUILD_DIR/geometry.json"\n',{mode:0o755});
    const report=await build(workspace,{bin});assert.equal(report.solids,1);
    const saved=await readFile(join(workspace,'part.step'),'utf8');
    for(const command of ['exit 1','exit 0']){
      await writeFile(bin,'#!/bin/sh\n'+command+'\n',{mode:0o755});
      await assert.rejects(()=>build(workspace,{bin}));
      const verdict=JSON.parse(await readFile(join(workspace,'.harness/verdict.json')));
      assert.equal(verdict.ready,false);assert.equal(verdict.artifact,null);
      assert.equal(await readFile(join(workspace,'part.step'),'utf8'),saved);
    }
  }finally{await rm(workspace,{recursive:true,force:true});}
});
