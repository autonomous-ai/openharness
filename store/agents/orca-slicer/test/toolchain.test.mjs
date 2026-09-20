// Transport fixtures test failure handling, not the native slicer's correctness.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,cp,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveProfile} from '../skills/orcaslicer/scripts/profiles.mjs';
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
test('fresh output required; failure clears readiness and preserves previous artifacts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-build-'));try{
 await cp(join(root,'template'),dir,{recursive:true});
 for(const name of ['printer','process','filament'])await writeFile(join(dir,name+'.json'),JSON.stringify({name}));
 await writeFile(join(dir,'slice-config.json'),JSON.stringify({mode:'custom',model:'model.stl',printer:'printer.json',process:'process.json',filament:'filament.json'}));
 const binary=join(dir,'fixture');await writeFile(binary,'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--outputdir" ]; then shift; out="$1"; fi; shift; done\nprintf "G90\\nM83\\nG0 Z.2\\n;TYPE:Outer wall\\nG1 X10 E1 F1200\\n" > "$out/fresh.gcode"\n');await chmod(binary,0o755);
 const run=()=>spawnSync(process.execPath,[join(root,'skills/orcaslicer/scripts/build.mjs')],{cwd:dir,env:{...process.env,ORCA_BIN:binary,HARNESS_WORKSPACE:dir},encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);const previous=await readFile(join(dir,'preview.html'),'utf8');assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,true);
 await writeFile(binary,'#!/bin/sh\nexit 0\n');result=run();assert.equal(result.status,1);assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).ready,false);assert.equal(await readFile(join(dir,'preview.html'),'utf8'),previous);
 await writeFile(binary,'#!/bin/sh\nprintf \'quoted "failure"\\n\' >&2\nexit 2\n');result=run();assert.equal(result.status,1);assert.equal(JSON.parse(await readFile(join(dir,'.harness/verdict.json'))).artifact,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
