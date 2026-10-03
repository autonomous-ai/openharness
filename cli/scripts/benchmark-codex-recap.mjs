import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
// Usage: node scripts/benchmark-codex-recap.mjs /absolute/new/output-directory
// Disposable files and child processes only; no live session or daemon is touched.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repo, 'cli/package.json'));
const digest = text => createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2);
if (args[0] === '--worker') {
  const [_, out, mode, file, expected] = args;
  const fixture = mkdtempSync(join(out, 'worker-'));
  Object.assign(process.env, { ADAPTER_DATA_DIR: join(fixture,'data'), ADAPTER_RUNTIME_DIR: join(fixture,'runtime'),
    ADAPTER_COMPUTER_ID_FILE: join(fixture,'computer-id'), ADAPTER_COMPUTER_ID: 'recap-benchmark', HARNESS_AUTH_DIR: join(fixture,'auth'),
    DSH_DIR: join(fixture,'dsh'), ZDOTDIR: fixture, HARNESS_LESSONS_DIR: join(fixture,'lessons'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json' });
  try {
    const module = await import(pathToFileURL(join(out,'reader.mjs')));
    for (let i=0;i<40;i++) await module[mode](join(out,'warmup.jsonl'));
    global.gc();
    const before = process.memoryUsage(), cpu = process.cpuUsage(), start = performance.now();
    const result = await module[mode](file);
    const durationMs = performance.now()-start, cpuDelta=process.cpuUsage(cpu), after=process.memoryUsage(), usage=process.resourceUsage();
    const output = JSON.stringify(result);
    assert.equal(digest(output),expected);
    process.stdout.write(JSON.stringify({mode,durationMs,cpuUs:cpuDelta.user+cpuDelta.system,before,after,maxRssKiB:usage.maxRSS,outputSha256:digest(output),outputBytes:Buffer.byteLength(output)})+'\n');
  } finally { rmSync(fixture,{recursive:true,force:true}); }
} else {
  assert.equal(args.length,1,'Expected a new absolute output directory');
  const out=args[0];
  assert(out.startsWith('/'),'Output directory must be absolute');
  mkdirSync(out);
  symlinkSync(join(repo,'cli/node_modules'),join(out,'node_modules'),'dir');
  const { build } = require('esbuild');
  await build({stdin:{contents:`import {tailFile} from './lib/transcriptTail.ts'; import {lastCodexTurnText} from './engines/codex/normalizer.ts'; export {readLastCodexTurnText as candidate} from './engines/codex/lastTurn.ts'; export async function baseline(file){return lastCodexTurnText(await tailFile(file,Infinity));}`,resolveDir:join(repo,'cli/src'),sourcefile:'recap-benchmark.ts',loader:'ts'},outfile:join(out,'reader.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',target:'node20',minify:true,logLevel:'silent'});
  const event = payload=>JSON.stringify({type:'event_msg',payload})+'\n';
  const prompt='Latest task 📘',answer='Verified final answer. '.repeat(400);
  const tail=event({type:'user_message',message:prompt})+event({type:'agent_message',phase:'commentary',message:'Working on it.'})+JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'recent tool data '.repeat(500)}})+'\n'+event({type:'agent_message',phase:'final_answer',message:answer});
  const expected=digest(JSON.stringify({userMessage:prompt,assistantText:answer}));
  writeFileSync(join(out,'warmup.jsonl'),tail);
  const record=Buffer.from(JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'older tool data '.repeat(4096)}})+'\n');
  const rows=[];
  const scenarios=[
    {name:'short-latest-0MiB',sizeMiB:0,shape:'short'},
    ...[1,64,512].map(sizeMiB=>({name:`short-latest-${sizeMiB}MiB`,sizeMiB,shape:'short'})),
    {name:'long-latest-64MiB',sizeMiB:64,shape:'long'},
    {name:'no-boundary-64MiB',sizeMiB:64,shape:'no-boundary'},
    {name:'single-tool-64MiB',sizeMiB:64,shape:'single-tool'},
  ];
  for(const {name,sizeMiB,shape} of scenarios) {
    const file=join(out,`${name}.jsonl`),fd=openSync(file,'wx',0o600);
    try {
      if(shape!=='no-boundary') writeSync(fd,event({type:'user_message',message:shape==='short'?'Earlier task':prompt}));
      if(shape==='single-tool') {
        writeSync(fd,'{"type":"response_item","payload":{"type":"function_call_output","output":"');
        const chunk=Buffer.alloc(65536,120);
        for(let written=0;written<sizeMiB*1048576;written+=chunk.length) writeSync(fd,chunk);
        writeSync(fd,'"}}\n');
      } else {
        for(let written=0;written<sizeMiB*1048576;written+=record.length) writeSync(fd,record);
      }
      writeSync(fd,shape==='short'?tail:event({type:'agent_message',phase:'final_answer',message:answer}));
    } finally { closeSync(fd); }
    const fileBytes=statSync(file).size;
    const expectedOutput=shape==='no-boundary'?digest(JSON.stringify({userMessage:'',assistantText:answer})):expected;
    try {
      for(let trial=0;trial<3;trial++) for(const mode of trial%2?['candidate','baseline']:['baseline','candidate']) {
        const result=spawnSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--worker',out,mode,file,expectedOutput],{cwd:out,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
        if(result.status!==0) throw new Error(`${name}/${mode}: ${result.stderr}\n${result.stdout}`);
        const row={name,sizeMiB,shape,fileBytes,trial,...JSON.parse(result.stdout.trim())};rows.push(row);
        console.log(JSON.stringify({name,trial,mode,ms:row.durationMs,maxRssMiB:row.maxRssKiB/1024}));
      }
    } finally { rmSync(file); }
  }
  const median = ns=>{const a=ns.slice().sort((a,b)=>a-b);return a[Math.floor(a.length/2)]};
  const summary=[];
  for(const {name} of scenarios) for(const metric of ['durationMs','cpuUs','maxRssKiB']) {
    const select=mode=>median(rows.filter(x=>x.name===name&&x.mode===mode).map(x=>x[metric]));
    const baseline=select('baseline'),candidate=select('candidate');summary.push({name,metric,baseline,candidate,reductionPercent:(1-candidate/baseline)*100});
  }
  const sources=['src/lib/transcriptTail.ts','src/engines/codex/normalizer.ts','src/engines/codex/lastTurn.ts','src/cli.ts','package-lock.json'];
  const sourceSha256=Object.fromEntries(sources.map(name=>[name,digest(readFileSync(join(repo,'cli',name)))]));
  const result={sourceSha256,finishedAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,scope:'Full-history recap vs reverse suffix using the same final parser, minified bundle, real synthetic files, disposable processes. No live app changes. Explicit GC runs only in benchmark children before timing.',rows,summary};
  writeFileSync(join(out,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({directory:out,summary},null,2));
}
