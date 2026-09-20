import {readFile,writeFile,mkdir,mkdtemp,readdir,rename,rm,copyFile,lstat,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname,basename,sep,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseMidi,writePracticeMidi} from './midi.mjs';
import {validateEnsemble,validateMusicSources,makeWrapper,checkEnsemble,sameNotes} from './ensemble.mjs';
import {zip} from './archive.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code==='ENOENT') return false; throw error; }
}
async function regularSource(workspace,name) {
  let path=workspace;
  for (const component of name.split('/')) {
    path=join(path,component);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Source symlinks are not portable: '+name);
  }
  const info=await lstat(path);
  if (!info.isFile() || info.size>1024*1024) throw new Error('Each source must be a regular file no larger than 1 MiB: '+name);
  if (!(await realpath(path)).startsWith(await realpath(workspace)+sep)) throw new Error('Source escapes workspace: '+name);
  return readFile(path);
}
export async function snapshotSources(workspace,spec) {
  const files=[];
  for (const name of spec.sourceFiles) files.push({name,bytes:await regularSource(workspace,name)});
  const allowed=new Set(files.map(file=>file.name));
  for (const file of files.filter(file=>/\.(ly|ily)$/i.test(file.name))) {
    for (const match of file.bytes.toString('utf8').matchAll(/\\include\s+"([^"]+)"/g)) {
      const included=posix.normalize(posix.join(posix.dirname(file.name),match[1]));
      if (match[1].startsWith('/') || !allowed.has(included)) throw new Error('Add the trusted include to sourceFiles: '+match[1]);
    }
  }
  return files;
}
async function unchanged(workspace,files) {
  for (const file of files) if (sha(await regularSource(workspace,file.name))!==sha(file.bytes)) throw new Error('Source changed during build; rebuild the saved project: '+file.name);
}
async function publish(workspace,state,stage,names) {
  const history=join(state,'history',basename(stage)); await mkdir(history,{recursive:true});
  const saved=[],installed=[];
  try {
    if (await exists(join(state,'score.json'))) await copyFile(join(state,'score.json'),join(history,'score.json'));
    for (const name of names) {
      if (await exists(join(workspace,name))) { await rename(join(workspace,name),join(history,name)); saved.push(name); }
      await rename(join(stage,name),join(workspace,name)); installed.push(name);
    }
    return history;
  } catch (error) {
    const failures=[];
    for (const name of installed.reverse()) try { await rename(join(workspace,name),join(stage,name)); } catch (error) { failures.push(error.message); }
    for (const name of saved.reverse()) try { await rename(join(history,name),join(workspace,name)); } catch (error) { failures.push(error.message); }
    if (failures.length) throw new Error('Publication failed; recover previous files from '+history+': '+failures.join('; '));
    throw error;
  }
}
export async function build(workspace,{bin=process.env.LILYPOND_BIN||'lilypond'}={}) {
  workspace=resolve(workspace);
  const meta=join(workspace,'.harness');
  if (await exists(meta) && (await lstat(meta)).isSymbolicLink()) throw new Error('.harness must not be a symlink.');
  await mkdir(meta,{recursive:true});
  const lock=join(meta,'score-build.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code==='EEXIST') throw new Error('Another build owns .harness/score-build.lock. Confirm its process has stopped before removing a stale lock.');
    throw error;
  }
  const atomic=async(path,value)=>{ const tmp=path+'.'+process.pid+'.tmp'; await writeFile(tmp,value); await rename(tmp,path); };
  const verdict=(ready,summary,findings=[],artifact=null)=>atomic(join(meta,'verdict.json'),json({spec:1,ready,summary,findings,artifact,updatedAt:new Date().toISOString()}));
  let stage,log='',report;
  try {
    await writeFile(join(lock,'owner.json'),json({pid:process.pid,startedAt:new Date().toISOString()}));
    await verdict(false,'Engraving fresh music, checking the player brief and preparing practice files');
    const contract=await exists(join(workspace,'ensemble.json')) ? await regularSource(workspace,'ensemble.json') : null;
    const spec=contract?validateEnsemble(JSON.parse(contract)):null;
    const files=await snapshotSources(workspace,spec||{sourceFiles:['score.ly']});
    if (spec) validateMusicSources(files);
    if (contract && !contract.equals(files.find(file=>file.name==='ensemble.json').bytes)) throw new Error('Ensemble brief changed while reading sources.');
    const sources=Object.fromEntries(files.map(file=>[file.name,sha(file.bytes)]).sort(([a],[b])=>a.localeCompare(b)));
    const sourceRevision=sha(JSON.stringify(sources));
    stage=await mkdtemp(join(meta,'score-')); const native=join(stage,'native'); await mkdir(native);
    for (const file of files) { const path=join(native,'source',file.name); await mkdir(dirname(path),{recursive:true}); await writeFile(path,file.bytes); }
    const run=args=>{
      const result=spawnSync(bin,args,{cwd:native,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
      log+=(result.stdout||'')+(result.stderr||'');
      if (result.error || result.status!==0) throw new Error('LilyPond failed: '+(result.error?.message||'exit '+result.status)+'. See .harness/render.log.');
      return result.stdout;
    };
    const version=run(['--version']).split('\n')[0];
    const render=async svg=>{
      const input=spec?join(native,'render.ly'):join(native,'source','score.ly');
      if (spec) await writeFile(input,makeWrapper(spec,{svg}));
      run(['-dwarning-as-error','-dno-point-and-click',svg?'--svg':'--pdf','-o',spec?native+sep:join(native,'score'),input]);
      await unchanged(workspace,files);
    };
    await render(false);
    const readMidi=async name=>{
      const file=(await readdir(native)).find(file=>file===name+'.midi'||file===name+'.mid');
      if (!file) throw new Error('Missing fresh MIDI for '+name+'.');
      const bytes=await readFile(join(native,file));
      return {bytes,data:parseMidi(bytes,{allowEmpty:true})};
    };
    const full=await readMidi('score');
    if (!full.data.notes.length || full.data.notes.length>10000 || full.data.duration>3600) throw new Error('Preview requires 1–10,000 notes and at most one hour.');
    let measured={checks:[],staves:[],notes:full.data.notes.map(note=>({...note,player:'music',staff:'track-'+note.track}))};
    const parts={};
    if (spec) {
      const proofs={};
      for (const player of spec.players) {
        parts[player.id]=(await readMidi('part-'+player.id));
        for (const staff of player.staves) proofs[staff.id]={concert:(await readMidi('concert-'+staff.id)).data,written:(await readMidi('written-'+staff.id)).data};
      }
      measured=checkEnsemble(spec,full.data,proofs,Object.fromEntries(Object.entries(parts).map(([id,part])=>[id,part.data])));
    }
    report={spec:1,checked:!!spec,title:spec?.title||files[0].bytes.toString().match(/\btitle\s*=\s*"([^"]+)"/)?.[1]||'Untitled score',
      sourceRevision,sources,engine:version,checks:measured.checks,staves:measured.staves,notes:full.data.notes.length,durationSeconds:full.data.duration,
      limitations:['Mechanical checks do not certify playability or musical quality. No real-player validation is implied.','Playback and practice MIDI are note-only sketches: no pedal, bend, sampled instruments or human performance.']};
    const failures=measured.checks.filter(check=>!check.passed);
    if (failures.length) {
      await atomic(join(meta,'failed-score.json'),json(report));
      throw new Error(failures.map(check=>check.id+': '+check.detail).join('\n')+'\nSee .harness/failed-score.json. The last successful score and practice pack are unchanged.');
    }
    await render(true);
    for (const [name,first] of [['score',full],...Object.entries(parts).map(([id,part])=>['part-'+id,part])]) {
      if (!first.bytes.equals((await readMidi(name)).bytes)) throw new Error('PDF and SVG passes produced different MIDI: '+name+'. Remove nondeterministic source and rebuild.');
    }
    const assets=join(stage,'score-assets'); await mkdir(assets);
    const documents=[];
    for (const item of [{id:'score',name:'score',label:'Full score'},...(spec?.players||[]).map(player=>({id:player.id,name:'part-'+player.id,label:player.label}))]) {
      const pdf=await readFile(join(native,item.name+'.pdf'));
      if (pdf.length<100 || pdf.subarray(0,5).toString()!=='%PDF-') throw new Error('Invalid fresh PDF: '+item.name);
      const names=(await readdir(native)).filter(name=>new RegExp('^'+item.name+'(?:-\\d+)?\\.svg$').test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      if (!names.length || names.length>40) throw new Error('Expected 1–40 engraved pages for '+item.name);
      for (const name of names) {
        const content=await readFile(join(native,name),'utf8');
        if (!content.includes('<svg') || content.length<100) throw new Error('Invalid SVG '+name);
        await writeFile(join(assets,name),content);
      }
      const target=item.id==='score'?join(stage,'score.pdf'):join(assets,item.name+'.pdf');
      await writeFile(target,pdf);
      documents.push({...item,pages:names.map(name=>'score-assets/'+name),pdf:item.id==='score'?'score.pdf':'score-assets/'+item.name+'.pdf'});
      if (item.id!=='score') await writeFile(join(assets,item.name+'.midi'),parts[item.id].bytes);
    }
    await writeFile(join(stage,'score.midi'),full.bytes);
    const practice=[];
    if (spec) {
      const exportPractice=async(name,label,selected)=>{
        const bytes=writePracticeMidi({notes:selected,division:full.data.division,endTick:full.data.endTick,quarterBpm:spec.quarterBpm,meter:spec.meter,...spec.practice});
        const parsed=parseMidi(bytes,{allowEmpty:true}), offset=spec.practice.countInBars*full.data.division*spec.meter[0]*4/spec.meter[1];
        const pitched={division:parsed.division,notes:parsed.notes.filter(note=>note.channel!==9).map(note=>({...note,startTick:note.startTick-offset,endTick:note.endTick-offset}))};
        if (!sameNotes({notes:selected,division:full.data.division},pitched) || parsed.endTick!==full.data.endTick+offset || Math.abs(parsed.tempos[0].tempo-60e6/(spec.quarterBpm*spec.practice.speed))>1.1) throw new Error('Practice MIDI round-trip failed: '+name);
        await writeFile(join(assets,name+'.midi'),bytes);
        practice.push({label,path:'score-assets/'+name+'.midi',notes:selected.length});
      };
      await exportPractice('practice-full','Slow ensemble + count-in',measured.notes);
      for (const player of spec.players) {
        await exportPractice('solo-'+player.id,player.label+' only',measured.notes.filter(note=>note.player===player.id));
        await exportPractice('minus-'+player.id,'Without '+player.label,measured.notes.filter(note=>note.player!==player.id));
      }
    }
    report.documents=documents.map(doc=>({id:doc.id,pdf:doc.pdf,pages:doc.pages.length}));
    report.practice=practice; report.ensemble=spec;
    await writeFile(join(assets,'checks.json'),json(report));
    const data={...report,documents,practice,midi:{...full.data,notes:measured.notes},players:spec?.players||[{id:'music',label:'Music'}]};
    const template=await readFile(new URL('preview.html',import.meta.url),'utf8'),app=await readFile(new URL('preview.js',import.meta.url),'utf8');
    const safe=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    await writeFile(join(stage,'score.html'),template.replace('__CONFIG__',()=>safe).replace('/*APP*/',()=>app));
    const outputs=['score.pdf','score.midi','score.html','score-assets'];
    if (spec) {
      const bundle=[...files];
      for (const name of ['build.mjs','ensemble.mjs','archive.mjs','midi.mjs','preview.html','preview.js','LICENSE']) bundle.push({name:'rebuild/'+name,bytes:await readFile(new URL(name,import.meta.url))});
      bundle.push({name:'REBUILD.md',bytes:Buffer.from('# '+spec.title+'\n\nInstall Node 20+ and LilyPond (tested '+version+'). From this extracted folder run:\n\n    node rebuild/build.mjs .\n\nSet LILYPOND_BIN if LilyPond is not on PATH. No Harness account or npm packages required.\nEdit ensemble.json for the saved brief, players and checks; edit score.ly for concert-pitch music variables. Only compile trusted LilyPond: it can execute Scheme.\n\nOpen score.html in a browser. The PDF, MIDI, player parts and practice files work outside Harness. Checks and source hashes are in score-assets/checks.json. A checked export is not a real-player endorsement.\n\nPractice exports use '+spec.practice.speed+'x tempo and '+spec.practice.countInBars+' count-in bar(s). These are note-only synthetic sketches, not recordings. Files in rebuild/ are MIT-licensed tools; see rebuild/LICENSE. Composition credit: '+spec.composer+'. Source permissions remain the creator’s responsibility.\n')});
      for (const name of outputs.filter(name=>name!=='score-assets')) bundle.push({name,bytes:await readFile(join(stage,name))});
      for (const name of await readdir(assets)) bundle.push({name:'score-assets/'+name,bytes:await readFile(join(assets,name))});
      await writeFile(join(stage,'score-project.zip'),zip(bundle)); outputs.push('score-project.zip');
    }
    await unchanged(workspace,files);
    report.previousArtifacts=await publish(workspace,meta,stage,outputs);
    await atomic(join(meta,'score.json'),json(report));
    await verdict(!!spec,spec?spec.players.length+' players · '+measured.checks.length+' checks passed · score, parts and practice pack ready':'Legacy score engraved; add ensemble.json to verify the player brief',
      [{severity:spec?'info':'warning',kind:'music',message:report.limitations.join(' ')}],'score.html');
    return report;
  } catch (error) {
    await verdict(false,'Score build failed',[{severity:'error',kind:'build',message:error.message}]);
    throw error;
  } finally {
    await atomic(join(meta,'render.log'),log);
    if (stage) await rm(stage,{recursive:true,force:true});
    await rm(lock,{recursive:true,force:true});
  }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const report=await build(process.argv[2]||process.env.HARNESS_WORKSPACE||process.cwd());
    console.log(report.checked?'Ready: '+report.checks.length+' measured checks; open score.html or download score-project.zip.':'Legacy engraving available; player requirements have not been checked.');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
