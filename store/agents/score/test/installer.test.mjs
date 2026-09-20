import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,chmod,copyFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {releaseFor,probeLilypond,findLilypond,ensureLilypond,resolveLilypond,VERSION} from '../skills/score/scripts/lilypond.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'score-install-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),folder=join(source,'lilypond-'+VERSION);await mkdir(join(folder,'bin'),{recursive:true});
  const bin=join(folder,'bin/lilypond');await writeFile(bin,'#!/bin/sh\nprintf "GNU LilyPond '+VERSION+'\\n"\n');await chmod(bin,0o755);
  const archive=join(root,'test.tar.gz'),tar=spawnSync('tar',['-czf',archive,'-C',source,'lilypond-'+VERSION],{encoding:'utf8'});assert.equal(tar.status,0,tar.stderr);
  const runtime=join(root,'runtime'),env={...process.env,SCORE_RUNTIME_DIR:runtime,LILYPOND_BIN:''};
  const release={...releaseFor('darwin','x64'),sha256:createHash('sha256').update(await readFile(archive)).digest('hex')};
  const options={env,platform:'darwin',arch:'x64',probe:(bin,env)=>bin.startsWith(runtime)?probeLilypond(bin,env):null,download:(_url,path)=>copyFile(archive,path),getRelease:()=>release,log:()=>{}};
  return {root,bin,archive,runtime,env,release,options};
}
test('a clean install verifies, extracts, runs and reuses its managed runtime',async t=>{
  const f=await fixture(t);assert.equal(await findLilypond(f.options),null);
  let downloads=0;const options={...f.options,download:async(...args)=>{downloads++;await f.options.download(...args);}};
  const installed=await ensureLilypond(options);assert.equal(installed.version,VERSION);assert.equal(downloads,1);
  assert.equal(await resolveLilypond(f.options),installed.bin);assert.equal((await ensureLilypond(options)).bin,installed.bin);assert.equal(downloads,1);
  assert.equal((await readdir(f.runtime)).some(n=>n.startsWith('.lilypond-install-')),false);
});
test('a broken checksum or extraction never publishes a runtime and leaves a retry possible',async t=>{
  const f=await fixture(t);
  await assert.rejects(ensureLilypond({...f.options,download:(_url,path)=>writeFile(path,'corrupt')}),/checksum/);
  assert.deepEqual(await readdir(f.runtime),[]);
  await assert.rejects(ensureLilypond({...f.options,unpack:async()=>{throw new Error('unpack failed');}}),/unpack failed/);
  assert.deepEqual(await readdir(f.runtime),[]);assert.equal((await ensureLilypond(f.options)).version,VERSION);
});
test('repair preserves a broken previous cache; explicit executable overrides are respected',async t=>{
  const f=await fixture(t),target=join(f.runtime,f.release.name);await mkdir(target,{recursive:true});await writeFile(join(target,'keep.txt'),'old cache evidence');
  await ensureLilypond(f.options);const backup=(await readdir(f.runtime)).find(n=>n.startsWith(f.release.name+'.previous-'));
  assert.equal(await readFile(join(f.runtime,backup,'keep.txt'),'utf8'),'old cache evidence');
  const found=await findLilypond({env:{...f.env,LILYPOND_BIN:f.bin}});assert.equal(found.bin,f.bin);
  await assert.rejects(ensureLilypond({...f.options,env:{...f.env,LILYPOND_BIN:join(f.root,'missing')}}),/configured LILYPOND_BIN/);
});
test('an existing system install needs no download, and unsupported machines get a specific error',async()=>{
  let downloaded=false;const result=await ensureLilypond({env:{LILYPOND_BIN:''},platform:'linux',arch:'arm64',probe:bin=>bin==='lilypond'?{bin,version:VERSION}:null,download:async()=>{downloaded=true;}});
  assert.equal(result.bin,'lilypond');assert.equal(downloaded,false);
  await assert.rejects(ensureLilypond({env:{LILYPOND_BIN:''},platform:'linux',arch:'arm64',probe:()=>null}),/linux\/arm64/);
});
