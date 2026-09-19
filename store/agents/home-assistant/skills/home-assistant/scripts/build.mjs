import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {normalize} from './model.mjs';
const ws=resolve(process.env.HARNESS_WORKSPACE||process.cwd()),meta=join(ws,'.harness');
await mkdir(meta,{recursive:true});
const verdict=async(ready,summary,findings=[])=>writeFile(join(meta,'verdict.json'),JSON.stringify({spec:1,ready,summary,findings,artifact:ready?'dashboard.html':null,updatedAt:new Date().toISOString()},null,2)+'\n');
await verdict(false,'Checking automation YAML…');
try{
  let parseDocument;
  try{({parseDocument}=await import('yaml'));}catch{throw new Error('YAML parser is missing. Run this harness’s toolchain/setup.sh.');}
  const source=await readFile(join(ws,'automations.yaml'),'utf8');
  if(Buffer.byteLength(source)>1024*1024)throw new Error('Keep automations.yaml under 1 MiB.');
  const doc=parseDocument(source,{uniqueKeys:true,strict:true});
  if(doc.errors.length||doc.warnings.length)throw new Error([...doc.errors,...doc.warnings].map(e=>e.message).join('\n'));
  const automations=normalize(doc.toJS({maxAliasCount:50}));
  const template=await readFile(new URL('dashboard.html',import.meta.url),'utf8');
  const model=(await readFile(new URL('model.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
  const app=await readFile(new URL('dashboard.js',import.meta.url),'utf8');
  const data=JSON.stringify({automations,source,at:new Date().toISOString()}).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  await writeFile(join(meta,'dashboard.tmp'),template.replace('/*MODEL*/',()=>model).replace('/*APP*/',()=>app).replace('__CONFIG__',()=>data));
  await rename(join(meta,'dashboard.tmp'),join(ws,'dashboard.html'));
  await verdict(true,'YAML and local structure checks passed',[{severity:'info',kind:'limits',message:'No Home Assistant instance or devices connected. Local scenario preview models a strict subset, not Home Assistant validation. Replace demo entity IDs before deployment.'}]);
  console.log('ok   '+automations.length+' automations → dashboard.html (local checks only)');
}catch(error){await verdict(false,'Automation checks failed',[{severity:'error',kind:'config',message:error.message}]);console.error(error.message);process.exitCode=1;}
