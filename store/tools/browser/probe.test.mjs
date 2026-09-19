import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { probe } from '../../viewers/isolated-web-viewer/probe.mjs';
import { build } from '../../agents/quantum-studio/skills/quantum/scripts/build.mjs';
import { root } from './helpers.mjs';

for(const harness of ['web-studio','data-studio','quantum-studio','gis']){
  test(harness+' meets the frame budget while its actual controls are being exercised',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'group-a-perf-'));
    try{
      await cp(join(root,'store/agents',harness,'template'),workspace,{recursive:true});
      if(harness==='quantum-studio')await build(workspace);
      const report=await probe({target:join(workspace,'index.html'),mode:'perf',seconds:3});
      if(process.env.HARNESS_QA_DIR)await writeFile(join(process.env.HARNESS_QA_DIR,harness+'-perf.json'),JSON.stringify(report,null,2));
      assert.equal(report.passed,true,report.errors.join('; '));
      assert.ok(report.interactionRounds>1);
      assert.ok(report.dependencies.some(file=>file.path==='index.html'));
      if(harness==='data-studio')assert.ok(report.dependencies.some(file=>file.path==='data.csv'));
      console.log(harness+': '+report.fps.toFixed(1)+' fps, p95 '+report.frameP95Ms.toFixed(1)+' ms, '+report.longTasks+' long tasks');
    }finally{await rm(workspace,{recursive:true,force:true});}
  });
}
test('a page that paints but throws or fails an interaction cannot pass the shared proof',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'group-a-bad-proof-'));
  try{
    await writeFile(join(workspace,'index.html'),'<button onclick="throw new Error(\'interaction broke\')">Click</button><output>waiting</output>');
    await writeFile(join(workspace,'proof.json'),JSON.stringify({actions:[{selector:'button',click:true},{selector:'output',text:'done'}]}));
    const previous=process.exitCode;
    const report=await probe({target:join(workspace,'index.html')});
    process.exitCode=previous;
    assert.equal(report.passed,false);
    assert.match(report.errors.join(' '),/interaction broke|expected/);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/browser-proof.json'),'utf8')).passed,false);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
