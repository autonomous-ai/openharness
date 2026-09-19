import {readFile,writeFile,mkdir,mkdtemp,readdir,rename,rm,copyFile,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {parseMidi} from './midi.mjs';
const ws=resolve(process.env.HARNESS_WORKSPACE||process.cwd()),meta=join(ws,'.harness');await mkdir(meta,{recursive:true});
const verdict=async(ready,summary,findings=[])=>writeFile(join(meta,'verdict.json'),JSON.stringify({spec:1,ready,summary,findings,artifact:ready?'score.html':null,updatedAt:new Date().toISOString()},null,2)+'\n');
await verdict(false,'Engraving source and checking note timing…');let stage,log='';
try{
 const source=await readFile(join(ws,'score.ly'),'utf8');if(source.length>1024*1024)throw new Error('Score source exceeds 1 MiB.');
 const bin=process.env.LILYPOND_BIN||'lilypond';stage=await mkdtemp(join(meta,'score-'));
 const run=args=>{const r=spawnSync(bin,args,{cwd:ws,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});log+=(r.stdout||'')+(r.stderr||'');if(r.error||r.status!==0)throw new Error(r.error?.message||'LilyPond rejected the score; inspect .harness/render.log.');};
 const prefix=join(stage,'score');run(['-dwarning-as-error','--pdf','-o',prefix,join(ws,'score.ly')]);
 const pdf=await readFile(prefix+'.pdf');if(pdf.length<100||pdf.subarray(0,5).toString()!=='%PDF-')throw new Error('LilyPond produced no fresh PDF.');
 let midiFile=(await readdir(stage)).find(name=>/^score\.(midi|mid)$/.test(name));if(!midiFile)throw new Error('Add a MIDI block to the score: no fresh MIDI was produced.');
 const midi=parseMidi(await readFile(join(stage,midiFile)));if(midi.notes.length>10000||midi.duration>3600)throw new Error('Playback preview is limited to 10,000 notes and one hour.');
 run(['-dwarning-as-error','--svg','-o',prefix,join(ws,'score.ly')]);
 const svg=(await readdir(stage)).filter(name=>/^score(?:-\d+)?\.svg$/.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));if(!svg.length||svg.length>40)throw new Error('Expected 1–40 SVG score pages.');
 const pages=[];for(const name of svg){const content=await readFile(join(stage,name),'utf8');if(content.length<100||!content.includes('<svg'))throw new Error('Invalid engraved SVG page.');pages.push(name);}
 const title=source.match(/\btitle\s*=\s*"([^"]+)"/)?.[1]||'Untitled score';
 const data={title,pages:pages.map(name=>'score-assets/'+name),midi};
 const template=await readFile(new URL('preview.html',import.meta.url),'utf8'),app=await readFile(new URL('preview.js',import.meta.url),'utf8');
 const safe=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 await writeFile(join(stage,'score.html'),template.replace('__CONFIG__',()=>safe).replace('/*APP*/',()=>app));
 const assets=join(stage,'assets');await mkdir(assets);for(const name of pages)await rename(join(stage,name),join(assets,name));
 // Back up only the generated assets directory; never remove source files.
 const destination=join(ws,'score-assets'),backup=join(stage,'previous-assets');let hadOld=false;
 try{await rename(destination,backup);hadOld=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await rename(assets,destination);}catch(error){if(hadOld)await rename(backup,destination);throw error;}
 await rename(prefix+'.pdf',join(ws,'score.pdf'));await copyFile(join(stage,midiFile),join(ws,'score.midi'));await rename(join(stage,'score.html'),join(ws,'score.html'));
 await writeFile(join(meta,'score.json'),JSON.stringify({pages:pages.length,notes:midi.notes.length,durationSeconds:midi.duration},null,2)+'\n');
 await verdict(true,pages.length+' engraved page'+(pages.length===1?'':'s')+' · '+midi.notes.length+' MIDI notes',[{severity:'info',kind:'playback',message:'Simple synthesized MIDI preview, not a performance or proof of musical correctness.'}]);
 console.log('ok   LilyPond → score.pdf + score.midi + score.html');
}catch(error){await verdict(false,'Score render failed',[{severity:'error',kind:'render',message:error.message}]);console.error(error.message);process.exitCode=1;}
finally{await writeFile(join(meta,'render.log'),log);if(stage)await rm(stage,{recursive:true,force:true});}
