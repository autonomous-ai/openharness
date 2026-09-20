import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from '../skills/quantum/scripts/build.mjs';

test('the real build safely embeds data and clears an old success verdict on a failed rebuild',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'quantum-build-'));
  try{
    await writeFile(join(workspace,'circuit.json'),JSON.stringify({name:'</script><script>alert("x")</script> $&',qubits:['q0'],gates:[{gate:'H',target:0}]}));
    const result=await build(workspace);
    assert.equal(result.probabilities.length,2);
    const html=await readFile(join(workspace,'index.html'),'utf8');
    assert.doesNotMatch(html,/<script>alert/);
    assert.match(html,/\\u003c\/script>/);
    assert.match(html,/\$&/);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/verdict.json'),'utf8')).ready,true);
    await writeFile(join(workspace,'circuit.json'),'{"qubits":["q0"],"gates":[{"gate":"CX","control":0,"target":0}]}');
    await assert.rejects(build(workspace),/different qubits/);
    const verdict=JSON.parse(await readFile(join(workspace,'.harness/verdict.json'),'utf8'));
    assert.equal(verdict.ready,false);
    assert.equal(verdict.artifact,null);
    assert.match(verdict.findings[0].message,/different qubits/);
    assert.equal(await readFile(join(workspace,'index.html'),'utf8'),html,'a failed build preserves the previous artifact while reporting failure');
  }finally{await rm(workspace,{recursive:true,force:true});}
});
