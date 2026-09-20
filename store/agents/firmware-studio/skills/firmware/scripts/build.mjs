import { access, readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function parseMemory(log){
  const read=label=>{const match=log.match(new RegExp(label+':[^\\n]*?used\\s+(\\d+)\\s+bytes\\s+from\\s+(\\d+)\\s+bytes','i'));return match&&Number(match[2])>0?{used:Number(match[1]),total:Number(match[2])}:null;};
  return {ram:read('RAM'),flash:read('Flash')};
}
export function projectConfig(source,requested){
  const sections=new Map();let section='';
  for(const raw of source.split(/\r?\n/)){const line=raw.trim();if(!line||/^[#;]/.test(line))continue;const heading=line.match(/^\[([^\]]+)\]$/);if(heading){section=heading[1];sections.set(section,{});continue;}const pair=line.match(/^([^=]+)=(.*)$/);if(pair&&sections.has(section))sections.get(section)[pair[1].trim()]=pair[2].trim();}
  const environment=requested||sections.get('platformio')?.default_envs?.split(/[\s,]+/)[0]||[...sections.keys()].find(name=>name.startsWith('env:'))?.slice(4);
  if(!environment||!/^[a-zA-Z0-9_.-]{1,80}$/.test(environment)||!sections.has('env:'+environment))throw new Error('Choose an existing [env:name] from platformio.ini.');
  return {...sections.get('env'),...sections.get('env:'+environment),environment};
}
async function executable(){
  const candidates=[process.env.PIO_BIN,'pio',process.env.FIRMWARE_TOOLCHAIN&&resolve(process.env.FIRMWARE_TOOLCHAIN,'../.venv/bin/pio')];
  for(const candidate of candidates.filter(Boolean))for(const file of candidate.includes('/')?[candidate]:(process.env.PATH||'').split(delimiter).map(dir=>join(dir,candidate))){try{await access(file,constants.X_OK);return file;}catch{}}
  throw new Error('PlatformIO not found. Set PIO_BIN or run harness dsh doctor autonomous/firmware-studio.');
}
export async function build(workspace,{bin,environment}={}){
  const state=join(workspace,'.harness');await mkdir(state,{recursive:true});
  const atomic=async(path,bytes)=>{const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,bytes);await rename(temporary,path);};
  const shell=await readFile(new URL('dashboard.html',import.meta.url),'utf8');
  const report={state:'building',summary:'Building the selected environment. No device access.',at:new Date().toISOString(),log:'',artifacts:[],pins:null};
  const publish=async()=>{
    const payload=JSON.stringify(report).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
    await atomic(join(workspace,'build-status.html'),shell.replace('<!--DATA-->',()=>payload));
    await atomic(join(state,'build.json'),JSON.stringify(report,null,2)+'\n');
    await atomic(join(state,'verdict.json'),JSON.stringify({spec:1,ready:report.state==='ok',summary:report.summary,findings:report.state==='failed'?[{severity:'error',kind:'compile',message:report.summary}]:[],artifact:'build-status.html',updatedAt:new Date().toISOString()},null,2)+'\n');
  };
  try{
    await publish();
    report.config=await readFile(join(workspace,'platformio.ini'),'utf8');
    const config=projectConfig(report.config,environment);for(const key of ['environment','board','platform','framework'])report[key]=config[key];
    try{
      const plan=JSON.parse(await readFile(join(workspace,'pins.json'),'utf8'));
      if(!plan||!Array.isArray(plan.pins)||plan.pins.length>100)throw new Error('pins.json needs a pins array (at most 100).');
      if(plan.note!==undefined&&typeof plan.note!=='string')throw new Error('The pin-plan note must be text.');
      for(const pin of plan.pins)if(!pin||typeof pin.pin!=='string'||typeof pin.role!=='string'||['direction','note'].some(key=>pin[key]!==undefined&&typeof pin[key]!=='string'))throw new Error('Each pin needs text pin/role fields and optional text direction/note fields.');
      report.pins=plan;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await publish();
    const started=performance.now();
    const result=spawnSync(bin||await executable(),['run','--project-dir',workspace,'-e',config.environment],{cwd:workspace,encoding:'utf8',timeout:600000,maxBuffer:20*1024*1024});
    report.duration=(performance.now()-started)/1000;report.log=(result.stdout||'')+(result.stderr||'');
    await atomic(join(state,'build.log'),report.log);Object.assign(report,parseMemory(report.log));
    if(result.error||result.status!==0)throw new Error('PlatformIO build failed: '+(result.error?.message||'exit '+result.status)+'.');
    const output=join(workspace,'.pio/build',config.environment);
    const names=(await readdir(output)).filter(name=>/^firmware\.(bin|hex|elf)$/.test(name));
    if(!names.length)throw new Error('PlatformIO exited successfully but produced no firmware binary.');
    await mkdir(join(workspace,'out'),{recursive:true});
    for(const name of names){const bytes=await readFile(join(output,name));if(!bytes.length)throw new Error(name+' is empty.');const path='out/'+config.environment+'-'+name;await atomic(join(workspace,path),bytes);report.artifacts.push({name:config.environment+'-'+name,path,bytes:bytes.length});}
    report.state='ok';report.summary=config.environment+' compiled and linked · not flashed';
    await publish();return report;
  }catch(error){report.state='failed';report.summary=error.message;report.artifacts=[];await publish();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log((await build(resolve(process.env.HARNESS_WORKSPACE||process.cwd()),{environment:process.argv[2]})).summary);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
