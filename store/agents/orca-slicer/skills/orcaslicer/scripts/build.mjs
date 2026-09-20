import {readFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {parseGcode} from './gcode.mjs';
import {profileWithSources,unchangedProfiles} from './profiles.mjs';
import {validateConfig,assertProfiles,prepareModel,inspectPlan,planSettings,assertMesh,canonicalReopenSettings} from './contract.mjs';
import {inspectSTL} from './mesh.mjs';
import {zip,unzip} from './archive.mjs';
import {engine,runNative,oneFile} from './native.mjs';
import {source,snapshot,unchanged,save,atomic,publish,transaction,sha,json} from './files.mjs';
const local=name=>new URL(name,import.meta.url);
const toolkit=['build.mjs','native.mjs','profiles.mjs','contract.mjs','mesh.mjs','archive.mjs','files.mjs','gcode.mjs','preview.html','preview.js','preview.css','serve-preview.mjs','LICENSE'];
const limits='Software checks only. No physical print, strength, fit, support adequacy, collision, firmware behavior, offsets, bed leveling or thermal safety is certified. Estimates are from the slicer, not measured print times. Custom purge/parking moves may be outside the model bed inset; review all commands in OrcaSlicer. Never send these files to an unverified printer.';
export async function build(workspace=process.env.HARNESS_WORKSPACE||process.cwd()){
 const ws=await realpath(resolve(workspace));
 return transaction(ws,async({state,stage,verdict})=>{
  let log='';try{
   const c=validateConfig(JSON.parse(await source(ws,'slice-config.json'))),files=await snapshot(ws,c.sourceFiles);
   const native=await engine(),resolved={},origins=[];
   for(const key of ['printer','process','filament']){
    const path=resolve(c.profiles.source==='installed'?native.profiles:ws,c.profiles[key]);
    if(c.profiles.source==='workspace')await source(ws,c.profiles[key]);
    const result=await profileWithSources(path);resolved[key]=result.profile;origins.push(result);
    if(c.profiles.source==='workspace')for(const entry of result.sources){
     const name=relative(ws,entry.path).split(sep).join('/');
     if(!c.sourceFiles.includes(name))throw new Error('Declare inherited workspace profile in sourceFiles: '+name);
     await source(ws,name);
    }
   }
   assertProfiles(resolved,c);
   const input=files.find(f=>f.name===c.model.path),model=prepareModel(input.bytes,c);
   const profilePaths=new Set(origins.flatMap(p=>p.sources.map(s=>relative(ws,s.path).split(sep).join('/'))));
   const semanticFiles=files.filter(f=>f.name!=='slice-config.json'&&!profilePaths.has(f.name)).map(f=>({name:f.name,sha256:sha(f.bytes)}));
   const revision=sha(json({brief:{...c,sourceFiles:undefined,profiles:undefined},sources:semanticFiles,profiles:resolved}));
   const report={spec:1,revision,title:c.title,brief:c.brief,assumptions:c.assumptions,machine:c.machine,model:{source:model.input,oriented:model.mesh,rotationDegrees:c.model.rotationDegrees,scale:c.model.scale},selectedPlan:c.selectedPlan,limits:c.limits,sourceFiles:files.map(f=>({name:f.name,sha256:sha(f.bytes)})),profileNames:Object.fromEntries(Object.entries(resolved).map(([k,p])=>[k,p.name])),plans:[],limitations:limits};
   const handoff=join(stage,'handoff');await mkdir(handoff);
   const bundle=[];
   const output=async(name,bytes)=>{await save(join(stage,name),bytes);bundle.push({name,bytes});};
   await save(join(stage,'oriented.stl'),model.bytes);
   for(const plan of c.plans){
    const job=join(stage,'job-'+plan.id),out=join(job,'out'),reopened=join(job,'reopened');await mkdir(out,{recursive:true});await mkdir(reopened);
    const printer=join(job,'printer.json'),process=join(job,'process.json'),filament=join(job,'filament.json');
    await save(printer,json(resolved.printer));await save(process,json({...resolved.process,...planSettings(plan)}));await save(filament,json(resolved.filament));
    const args=['--datadir',join(job,'appdata'),'--debug','2','--slice','0','--arrange','1','--orient','0','--allow-rotations=0','--ensure-on-bed','--load-settings',printer+';'+process,'--load-filaments',filament,'--outputdir',out,'--export-3mf','project.3mf','--export-settings',join(job,'effective.json'),'--curr-bed-type='+c.machine.bedType,'--enable-arc-fitting=0','--post-process','',join(stage,'oriented.stl')];
    log+='\nPLAN '+plan.id+'\n'+runNative(native.bin,args,job);
    const raw=await oneFile(out,'.gcode'),project=await oneFile(out,'.3mf'),effective=JSON.parse(await readFile(join(job,'effective.json'))),parsed=parseGcode(raw.bytes.toString('utf8'));
    const checks=inspectPlan(parsed,effective,c,plan,model.mesh),members=unzip(project.bytes);
    const embedded=members.get('Metadata/plate_1.gcode'),digest=members.get('Metadata/plate_1.gcode.md5');
    if(!embedded?.equals(raw.bytes)||digest?.toString('utf8').trim().toLowerCase()!==createHash('md5').update(raw.bytes).digest('hex'))throw new Error(plan.id+': Native 3MF does not contain the exact checked G-code.');
    const projectSettings=JSON.parse(members.get('Metadata/project_settings.config')||'null');
    const withoutVersion=object=>Object.fromEntries(Object.entries(object||{}).filter(([key])=>key!=='version'));
    if(!isDeepStrictEqual(withoutVersion(projectSettings),withoutVersion(effective)))throw new Error(plan.id+': Embedded project settings disagree with the effective slice.');
    checks.push({name:'Native 3MF payload',pass:true,detail:'Embedded G-code equals checked file byte-for-byte; MD5 agrees; all settings agree except native project schema version.'});
    log+='\nREOPEN '+plan.id+'\n'+runNative(native.bin,['--datadir',join(job,'reopen-appdata'),'--debug','2','--info','--arrange','0','--orient','0','--export-stl','--export-settings',join(reopened,'effective.json'),'--outputdir',reopened,'--enable-arc-fitting=0','--post-process','',join(out,project.name)],job);
    const reopenSettings=JSON.parse(await readFile(join(reopened,'effective.json'))),reopenSTL=await oneFile(join(reopened,'stl'),'.stl'),reopenMesh=inspectSTL(reopenSTL.bytes);
    assertMesh(reopenMesh,'Native reopened 3MF mesh');
    if(!isDeepStrictEqual(canonicalReopenSettings(reopenSettings),canonicalReopenSettings(effective))){
     const changes=[...new Set([...Object.keys(effective),...Object.keys(reopenSettings)])].filter(key=>!isDeepStrictEqual(effective[key],reopenSettings[key])).map(key=>({key,before:effective[key],after:reopenSettings[key]}));
     log+='\nREOPEN SETTINGS DIFFERENCES\n'+json(changes);throw new Error(plan.id+': Native reopened 3MF settings changed: '+changes.map(c=>c.key).join(', '));
    }
    if(reopenMesh.bounds.size.some((n,i)=>Math.abs(n-model.mesh.bounds.size[i])>.03)||Math.abs(reopenMesh.volumeMM3-model.mesh.volumeMM3)>Math.max(.05,model.mesh.volumeMM3*.00001)||reopenMesh.triangles!==model.mesh.triangles||reopenMesh.shells.length!==model.mesh.shells.length)throw new Error(plan.id+': Native reopened project geometry changed.');
    checks.push({name:'Native 3MF reopen',pass:true,detail:'Orca reopened project: all settings agree (absent/empty upward_compatible_machine metadata normalized); dimensions ±0.03 mm, volume 1e-5 relative, triangles and closed shell count agree.'});
    const base='handoff/plans/'+plan.id;
    const summary={...plan,stats:parsed.stats,layers:parsed.modelLayers,moves:parsed.moves,bounds:parsed.modelBounds,fullMotionBounds:parsed.motionBounds,warnings:parsed.warnings,temperatures:parsed.temperatures,commands:parsed.commands,checks,effective,sha256:{gcode:sha(raw.bytes),project:sha(project.bytes)},gcode:base+'/part.gcode',project:base+'/project.3mf',settings:base+'/effective.json',reopenedMesh:reopenMesh};
    report.plans.push(summary);
    await output(summary.gcode,raw.bytes);await output(summary.project,project.bytes);await output(summary.settings,json(effective));
    await output(base+'/inspection.json',json({...summary,effective:undefined}));
    if(plan.id===c.selectedPlan){await save(join(stage,'part.gcode'),raw.bytes);await save(join(stage,'part.3mf'),project.bytes);}
   }
   const portableProfiles={source:'workspace',printer:'profiles/printer.json',process:'profiles/process.json',filament:'profiles/filament.json'};
   const sourceFiles=files.filter(f=>f.name!=='slice-config.json'&&!profilePaths.has(f.name));
   const portable={...c,profiles:portableProfiles,sourceFiles:['slice-config.json',...sourceFiles.map(f=>f.name),...['printer','process','filament'].map(k=>portableProfiles[k])]};
   bundle.push(...sourceFiles,{name:'slice-config.json',bytes:json(portable)});
   for(const [key,value]of Object.entries(resolved))bundle.push({name:portableProfiles[key],bytes:json(value)});
   const notices='OpenHarness wrapper and generated inspection UI: MIT (rebuild/LICENSE).\nOrcaSlicer 2.4.2 is separately installed, not included. OrcaSlicer and its bundled profiles are upstream software/data, not relicensed as OpenHarness MIT code. Flattened profile exports derive from the selected Orca/user presets; retain their original notices and terms.\nUpstream: https://github.com/OrcaSlicer/OrcaSlicer\nOrcaSlicer license: https://github.com/OrcaSlicer/OrcaSlicer/blob/main/LICENSE\nProfile source directory: https://github.com/OrcaSlicer/OrcaSlicer/tree/main/resources/profiles\nNo binary, printer connection or credentials are included.\n';
   bundle.push({name:'PROFILE-NOTICES.txt',bytes:notices});
   for(const name of toolkit)bundle.push({name:'rebuild/'+name,bytes:await readFile(local(name))});
   report.engine={name:'OrcaSlicer',version:report.plans[0].effective.version};
   await output('handoff/report.json',json(report));
   const template=await readFile(local('preview.html'),'utf8'),safe=JSON.stringify(report).replaceAll('<','\\u003c');
   await output('preview.html',template.replace('__REPORT__',()=>safe));
   for(const name of ['preview.js','preview.css','gcode.mjs'])await output('handoff/'+name,await readFile(local(name)));
   const readme='# '+c.title+'\n\n'+c.brief+'\n\n'+c.assumptions+'\n\n'+limits+'\n\nEach handoff/plans/<id>/ folder contains the actual G-code, native editable project.3mf, effective settings and inspection receipt. Open the 3MF in OrcaSlicer and inspect the correct machine, plate, filament, orientation, custom start/end code, first layer and supports before any physical use.\n\nNode 22+, OrcaSlicer 2.4.2 separately installed:\n\n    ORCA_BIN=/path/to/OrcaSlicer node rebuild/build.mjs\n    node rebuild/serve-preview.mjs .\n\nOpen the loopback URL printed by the preview server. Double-clicking preview.html cannot fetch toolpaths from file://. Exported 3MF and G-code do not need this server.\n\nEdit slice-config.json to save requirements/plan revisions before rebuilding. The machine context is '+c.machine.context+'. Do not change it to user without confirming your actual printer/material. Rebuilds never connect to or start a printer. Output failure preserves the last successful handoff; .harness/verdict.json distinguishes it from current inputs. A downloaded review JSON is notes/view state, not printing authorization.\n';
   bundle.push({name:'README.md',bytes:readme});await output('handoff/README.txt',readme);
   await save(join(handoff,'project.zip'),zip(bundle));
   await unchanged(ws,files);await unchangedProfiles(origins);
   const history=await publish(ws,state,stage,['handoff','part.gcode','part.3mf','preview.html']);
   await atomic(join(state,'slice.json'),json({...report,history:relative(ws,history)}));
   await verdict({ready:true,artifact:'preview.html',summary:report.plans.length+' native slicing plans checked and reopened · '+(c.machine.context==='example'?'example printer only':'printer brief supplied')+' · not print-tested',findings:[{severity:'warning',kind:'physical-review',message:limits}]});
   console.log('ok   '+report.plans.length+' plans · '+report.plans.reduce((n,p)=>n+p.checks.length,0)+' checks · G-code + native 3MF + portable project');
   return report;
  }catch(error){log+='\n'+(error.nativeLog||'');throw error;}finally{await atomic(join(state,'slice.log'),log);}
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))build().catch(error=>{console.error(error.message);process.exitCode=1;});
