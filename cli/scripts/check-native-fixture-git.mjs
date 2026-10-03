/** Native fixture cleanup check. Two Git requests wait on a private loopback
 * server. Only the one inside the fixture may be stopped; the neighbor must
 * survive until this check closes its own HTTP server. No external network.
 * Run from cli/: node --import tsx scripts/check-native-fixture-git.mjs
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {cleanupFixtureGit} from './native-fixture-git.ts';
const own=realpathSync(mkdtempSync(join(tmpdir(),'harness-resume-native-')));
const other=realpathSync(mkdtempSync(join(tmpdir(),'harness-git-neighbor-')));
process.env.ADAPTER_DATA_DIR=join(own,'state');
let requests=0;const server=createServer(()=>{requests++});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/fixture.git`;
const start=cwd=>{const child=spawn('git',['-c','http.proxy=','-c','credential.helper=','ls-remote',endpoint],{cwd,stdio:'ignore',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});let exited=false;const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve()}));return {child,exit,isExited:()=>exited}};
const target=start(own),neighbor=start(other);
try {
 for(let i=0;i<100&&requests<2;i++)await wait(50);
 assert.equal(requests,2,'Both controlled Git processes must be waiting on local HTTP');
 const cleaned=await cleanupFixtureGit(own);
 assert(cleaned>0,'Must exercise the real signal/identity branch, not an empty scan');
 await Promise.race([target.exit,wait(3000).then(()=>{throw Error('Owned Git failed to exit')})]);
 assert(!neighbor.isExited(),'Cleanup must preserve a neighboring Git process');
 console.log(JSON.stringify({cleanedProcesses:cleaned,ownedGitExited:true,neighborPreserved:true}));
}finally{
 server.closeAllConnections();await new Promise(r=>server.close(r));
 await Promise.all([target.exit,neighbor.exit]);rmSync(own,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});
}
