import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {serve} from '../skills/orcaslicer/scripts/serve-preview.mjs';
test('portable preview serves only bounded artifacts on loopback; no source leaks or writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'orca-preview-'));let server;
 try{
  await mkdir(join(dir,'handoff/plans/draft'),{recursive:true});
  await writeFile(join(dir,'preview.html'),'<h1>saved slice</h1>');
  await writeFile(join(dir,'handoff/gcode.mjs'),'export const checked=true;');
  await writeFile(join(dir,'handoff/plans/draft/part.gcode'),'G1 X1');
  await writeFile(join(dir,'private-note.txt'),'never serve this');
  await symlink(join(dir,'private-note.txt'),join(dir,'handoff/report.json'));
  server=await serve(dir);const base='http://127.0.0.1:'+server.address().port;
  const root=await fetch(base+'/',{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/preview.html');
  const page=await fetch(base+'/preview.html');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const module=await fetch(base+'/handoff/gcode.mjs');assert.match(module.headers.get('content-type'),/javascript/);
  const artifact=await fetch(base+'/handoff/plans/draft/part.gcode');assert.equal(await artifact.text(),'G1 X1');assert.match(artifact.headers.get('content-disposition'),/attachment/);
  for(const path of ['/private-note.txt','/slice-config.json','/.harness/verdict.json','/handoff/report.json','/handoff/%2e%2e%2fprivate-note.txt'])assert.equal((await fetch(base+path)).status,404,path);
  assert.equal((await fetch(base+'/preview.html',{method:'POST'})).status,405);
  const badHost=await new Promise((resolve,reject)=>{const req=request(base+'/preview.html',{headers:{host:'example.com'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(badHost,403);
  await writeFile(join(dir,'handoff/project.zip'),Buffer.alloc(32*1024*1024+1));
  assert.equal((await fetch(base+'/handoff/project.zip')).status,404);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
