import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { AgentCreationReceipts, creationFingerprint } = await import(pathToFileURL(process.argv[2]).href);
const root = mkdtempSync(join(tmpdir(), 'receipt-cost-'));
try {
 const store = new AgentCreationReceipts(join(root, 'receipts'));
 const request = { kind:'model-create-v1', local:false, input:{engine:'claude',cwd:'/fixture/project',grid:null}, selection:{model:'fixture-model',grid:'fixture-grid'} };
 const fp = creationFingerprint(request), held = { service:'models', detail:'Waiting for the selected model.' };
 const samples = [], cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
 for(let n=0;n<60;n++) {
  const id = `fixture-creation-${n}`, effect = async()=>({state:'created',agentId:`fixture-agent-${n}`});
  const start = performance.now();
  if (process.argv[3] === 'intent') await store.runIntent(id, fp, request, held, async()=>effect);
  else await store.run(id, fp, effect);
  new AgentCreationReceipts(join(root,'receipts')).status(id);
  samples.push(performance.now()-start);
 }
 const used = process.cpuUsage(cpu);
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({ mode:process.argv[3], count:samples.length, medianMs:samples[30], p95Ms:samples[57], totalMs:samples.reduce((a,b)=>a+b,0), cpuMs:(used.user+used.system)/1000, rssDeltaMiB:(process.memoryUsage().rss-rss)/1048576 }));
} finally { rmSync(root,{recursive:true,force:true}); }
