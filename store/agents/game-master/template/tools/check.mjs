#!/usr/bin/env node
import {Worker} from 'node:worker_threads';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProject} from './build.mjs';
export function checkRules(project,options={},operation='check'){return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./rules-runner.mjs',import.meta.url),{workerData:{project,options,operation}}),timer=setTimeout(()=>{worker.terminate();reject(new Error('Rule check exceeded 60 seconds. Revise the rules or reduce the sample.'));},60000);worker.once('message',m=>{clearTimeout(timer);worker.terminate();m.ok?resolve(m):reject(new Error(m.error));});worker.once('error',e=>{clearTimeout(timer);reject(e);});worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Rule check stopped.'));});});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),at=process.argv.indexOf('--seeds'),count=at>=0?Number(process.argv[at+1]):50;const p=await readProject(root),{report}=await checkRules(p,{count});await mkdir(join(root,'.harness'),{recursive:true});await writeFile(join(root,'.harness/game-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({completed:report.completed,errors:report.errors,capped:report.capped,repeated:report.repeated,scope:report.scope}));}
