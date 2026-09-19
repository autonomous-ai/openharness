import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, parseMemory, projectConfig } from '../skills/firmware/scripts/build.mjs';
test('compiler memory reports remain numeric and missing information is not invented',()=>{
  assert.deepEqual(parseMemory('RAM: [= ] 6.6% (used 21464 bytes from 327680 bytes)\nFlash: [== ] 20.5% (used 269197 bytes from 1310720 bytes)'),{ram:{used:21464,total:327680},flash:{used:269197,total:1310720}});
  assert.deepEqual(parseMemory('Build succeeded'),{ram:null,flash:null});
  assert.equal(projectConfig('[platformio]\ndefault_envs=b\n[env]\nframework=arduino\n[env:a]\nboard=a\n[env:b]\nboard=b').environment,'b');
  assert.throws(()=>projectConfig('[env:a]\n','unknown'));
});
test('the build invokes PlatformIO once, publishes real artifact bytes, and replaces a stale success on failure',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'firmware-build-test-'));
  try{
    await writeFile(join(workspace,'platformio.ini'),'[env:test]\nboard=example\nframework=arduino\n');
    await writeFile(join(workspace,'pins.json'),JSON.stringify({pins:[{pin:'GPIO 2',role:'</script><script>window.injected=1</script>'}]}));
    const bin=join(workspace,'fake-pio');
    await writeFile(bin,'#!/bin/sh\necho call >> calls\nmkdir -p .pio/build/test\nprintf "real artifact fixture" > .pio/build/test/firmware.bin\necho "RAM: [= ] 10% (used 10 bytes from 100 bytes)"\n',{mode:0o755});
    const report=await build(workspace,{bin});assert.equal(report.state,'ok');assert.equal(report.ram.used,10);
    assert.equal((await readFile(join(workspace,'calls'),'utf8')).trim(),'call');
    assert.equal(await readFile(join(workspace,'out/test-firmware.bin'),'utf8'),'real artifact fixture');
    const html=await readFile(join(workspace,'build-status.html'),'utf8');assert.ok(!html.includes('</script><script>window.injected'));
    await writeFile(bin,'#!/bin/sh\necho "compile error" >&2\nexit 1\n',{mode:0o755});
    await assert.rejects(()=>build(workspace,{bin}),/failed/);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/verdict.json'))).ready,false);
    const failed=JSON.parse(await readFile(join(workspace,'.harness/build.json')));assert.equal(failed.state,'failed');assert.deepEqual(failed.artifacts,[]);assert.match(failed.log,/compile error/);
    await writeFile(join(workspace,'pins.json'),'{"pins":[null]}');await assert.rejects(()=>build(workspace,{bin}),/Each pin/);
    assert.equal(JSON.parse(await readFile(join(workspace,'.harness/build.json'))).pins,null);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
