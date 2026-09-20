import {access,readFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectSTL,parseSTL,binarySTL} from './mesh.mjs';
import {validateDesign,parametersFor,checkFor,regionScad} from './design.mjs';
import {number} from './expression.mjs';
import {Native,partCall,imported,projection} from './native.mjs';
import {sha,json,exists,source,snapshot,unchanged,save,atomic,publish,transaction} from './files.mjs';
import {zip} from './archive.mjs';
import {handoff} from './handoff.mjs';

const limitations=[
  'Checks measure declared regions, bounds and printer envelope on exported meshes. They do not prove global minimum wall thickness, absence of all self-intersections, strength, overhangs, food safety or physical fit.',
  'Build-envelope checks are per part in the saved orientation, not a packed plate, support plan or slicing result. STL dimensions are millimetres.',
  'Section views are inspection references, not certified manufacturing drawings. Print the fit coupon when provided; measure the real result before committing to a full batch.'
];
const equal=(a,b,tolerance)=>a.length===b.length&&a.every((value,i)=>Math.abs(value-b[i])<=tolerance);
const shape=bytes=>parseSTL(bytes).map(triangle=>{
  const vertices=triangle.map(point=>point.map(value=>Number(value.toFixed(5))).join(','));
  return [0,1,2].map(i=>[...vertices.slice(i),...vertices.slice(0,i)].join(';')).sort()[0];
}).sort().join('\n');
function closed(mesh){return mesh.watertight&&mesh.volumeMM3>0&&mesh.orientedVolumeMM3>0;}
function equivalent(a,b){
  return closed(a)&&closed(b)&&a.shells.length===b.shells.length&&equal(a.bounds.size,b.bounds.size,.02)&&Math.abs(a.volumeMM3-b.volumeMM3)<=Math.max(.02,a.volumeMM3*1e-4);
}
export async function findExecutable(candidates){
  for(const candidate of candidates.filter(Boolean))for(const file of candidate.includes('/')?[candidate]:(process.env.PATH||'').split(delimiter).map(dir=>join(dir,candidate))){
    try{await access(file,constants.X_OK);return file;}catch{}
  }
  throw new Error('OpenSCAD not found. Install OpenSCAD, set OPENSCAD_BIN, or run harness dsh doctor autonomous/openscad.');
}
export async function build(workspace,{bin}={}){
  workspace=resolve(workspace);
  return transaction(workspace,async({state,stage,verdict})=>{
    const directory=join(stage,'native');await mkdir(directory);
    const executable=bin||await findExecutable([process.env.OPENSCAD_BIN,process.env.OPENSCAD_TOOLCHAIN&&join(process.env.OPENSCAD_TOOLCHAIN,'openscad-cli'),'openscad','/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD']);
    const native=new Native(executable,directory);
    try{
      const contract=await exists(join(workspace,'design.json'))?await source(workspace,'design.json'):null;
      const design=contract?validateDesign(JSON.parse(contract)):null;
      const files=await snapshot(workspace,design?.sourceFiles||['model.scad']);
      if(contract&&!contract.equals(files.find(file=>file.name==='design.json').bytes))throw new Error('Design brief changed while reading sources.');
      const sources=Object.fromEntries(files.map(file=>[file.name,sha(file.bytes)]).sort(([a],[b])=>a.localeCompare(b)));
      const sourceRevision=sha(JSON.stringify(sources));
      for(const file of files)await save(join(directory,'source',file.name),file.bytes);
      const allowed=files.map(file=>join(directory,'source',file.name));
      const engine=native.version();
      if(!design){
        const fresh=await native.render('legacy','include <source/model.scad>\n',{allowedDependencies:allowed});
        const mesh=inspectSTL(fresh.bytes);
        if(!closed(mesh))throw new Error('Legacy mesh is not closed, consistently wound and positive-volume.');
        await unchanged(workspace,files);
        await save(join(stage,'part.stl'),fresh.bytes);
        const report={...mesh,spec:1,checked:false,engine,sourceRevision,sources,limitations};
        report.previousArtifacts=await publish(workspace,state,stage,['part.stl']);
        await atomic(join(state,'mesh.json'),json(report));
        await verdict({ready:false,artifact:'part.stl',summary:'Geometry preview only: add design.json to check requirements and prepare a portable handoff',findings:[{severity:'warning',kind:'requirements',message:limitations.join(' ')}]});
        return report;
      }
      const report={spec:1,checked:true,title:design.title,design,engine,sourceRevision,sources,checks:[],variants:[],limitations};
      const meshes=new Map(),outputs=[];
      const put=async(name,bytes)=>{await save(join(stage,name),bytes);outputs.push({name,bytes:Buffer.from(bytes)});};
      const check=(variant,id,label,passed,detail,measured)=>report.checks.push({variant,id,label,passed,detail,...(measured===undefined?{}:{measured})});
      for(const variant of design.variants){
        const parameters=parametersFor(design,variant),result={id:variant.id,label:variant.label,parameters,notes:variant.notes,parts:[]};
        report.variants.push(result);
        for(const part of design.parts){
          const prefix=variant.id+'-'+part.id,code='use <source/model.scad>\n'+partCall(part.id,parameters)+'\n';
          const fresh=await native.render(prefix,code,{allowedDependencies:allowed});
          const repeat=await native.render(prefix+'-repeat',code,{allowedDependencies:allowed});
          if(shape(fresh.bytes)!==shape(repeat.bytes))throw new Error(prefix+': repeated source exports disagree. Remove nondeterministic geometry and rebuild.');
          const mesh=inspectSTL(fresh.bytes);
          const passed=closed(mesh)&&mesh.shells.length===part.shells;
          check(variant.id,prefix+'-topology',part.label+' · mesh integrity',passed,passed?mesh.triangles+' triangles; '+mesh.shells.length+' connected surface shell(s); positive oriented volume':
            'Expected a closed, consistently wound mesh with '+part.shells+' surface shell(s).',mesh);
          meshes.set(prefix,{...fresh,mesh});
          result.parts.push({id:part.id,label:part.label,quantity:part.quantity,notes:part.notes,mesh,views:[]});
        }
        for(const raw of design.checks){
          const required=checkFor(raw,parameters),part=meshes.get(variant.id+'-'+raw.part),id=variant.id+'-'+raw.id;
          let passed,detail,measured;
          if(required.kind==='bounds'){
            measured=part.mesh.bounds;
            passed=equal(measured.size,required.size,required.tolerance)&&equal(measured.min,required.origin,required.tolerance);
            detail='Size '+measured.size.map(v=>v.toFixed(3)).join(' × ')+' mm; required '+required.size.join(' × ')+' mm, origin '+required.origin.join(', ')+'; tolerance ±'+required.tolerance+' mm.';
          }else if(required.kind==='volume'){
            measured=part.mesh.volumeMM3;passed=measured>=required.range[0]&&measured<=required.range[1];
            detail=measured.toFixed(2)+' mm³; required '+required.range.join('–')+' mm³.';
          }else{
            let code;
            if(required.kind==='empty')code='intersection(){'+imported(part.file)+regionScad(required.region)+'}';
            if(required.kind==='contains')code='difference(){'+regionScad(required.region)+imported(part.file)+'}';
            if(required.kind==='separated')code='intersection(){'+imported(part.file)+'translate('+JSON.stringify(required.translation)+') rotate('+JSON.stringify(required.rotation)+') '+imported(meshes.get(variant.id+'-'+required.other).file)+'}';
            const probe=await native.render(id,code,{emptyAllowed:true});
            passed=probe.empty;measured=probe.empty?0:inspectSTL(probe.bytes).volumeMM3;
            detail=passed?(required.kind==='contains'?'Required material region is fully contained.':required.kind==='empty'?'Required clearance region is empty.':'Parts do not overlap in the declared relative placement.'):
              'Unexpected '+(required.kind==='contains'?'missing':'intersecting')+' material: '+measured.toFixed(4)+' mm³.';
          }
          check(variant.id,id,raw.label,passed,detail,measured);
        }
      }
      const fail=async()=>{
        const failures=report.checks.filter(item=>!item.passed);
        if(failures.length){
          await atomic(join(state,'failed-mesh.json'),json(report));
          throw new Error(failures.map(item=>item.id+': '+item.detail).join('\n')+'\nSee .harness/failed-mesh.json. Previous successful files are unchanged.');
        }
      };
      await fail();
      for(const variant of report.variants){
        for(const part of variant.parts){
          const definition=design.parts.find(item=>item.id===part.id),prefix=variant.id+'-'+part.id,original=meshes.get(prefix);
          const rotated=await native.render(prefix+'-orient','rotate('+JSON.stringify(definition.printRotation)+') '+imported(original.file));
          const rotatedMesh=inspectSTL(rotated.bytes);
          if(!closed(rotatedMesh)||rotatedMesh.shells.length!==part.mesh.shells.length||Math.abs(rotatedMesh.volumeMM3-part.mesh.volumeMM3)>Math.max(.02,part.mesh.volumeMM3*1e-4))throw new Error(prefix+': orientation changed mesh volume, shell count or closure.');
          const printBytes=binarySTL(parseSTL(rotated.bytes),rotatedMesh.bounds.min.map(value=>-value));
          const local=join(directory,prefix+'-print.stl');await save(local,printBytes);
          const reopened=await native.render(prefix+'-reopen',imported(local));
          const printMesh=inspectSTL(printBytes),reopenedMesh=inspectSTL(reopened.bytes);
          if(!equivalent(printMesh,reopenedMesh)||!equal(printMesh.bounds.min,[0,0,0],.001)||!equal(reopenedMesh.bounds.min,[0,0,0],.02))throw new Error(prefix+': native re-import disagrees with the print-oriented STL.');
          part.printMesh=printMesh;part.printRotation=definition.printRotation;part.path='handoff/parts/'+prefix+'.stl';part.sha256=sha(printBytes);
          check(variant.id,prefix+'-reopen',part.label+' · exported STL reopens',true,'Native OpenSCAD re-import preserves volume, closure and dimensions. Print coordinates start at [0, 0, 0].');
          const envelope=design.process.bedMM,margin=design.process.edgeMarginMM;
          const fits=printMesh.bounds.size.every((size,i)=>size+(i<2?2*margin:0)<=envelope[i]+.001);
          check(variant.id,prefix+'-bed',part.label+' · build envelope',fits,'Oriented size '+printMesh.bounds.size.map(v=>v.toFixed(2)).join(' × ')+' mm; printer '+envelope.join(' × ')+' mm; XY edge margin '+margin+' mm per side.',printMesh.bounds.size);
          await put(part.path,printBytes);
          for(const view of ['top','front','side']){
            const raw=definition.views[view].at,at=raw===null?null:number(raw,variant.parameters,'Section position'),axis={top:2,front:1,side:0}[view];
            if(at!==null&&(at<=part.mesh.bounds.min[axis]+.001||at>=part.mesh.bounds.max[axis]-.001))throw new Error(prefix+': '+view+' section must lie strictly inside the measured bounds.');
            const drawing=await native.render(prefix+'-'+view,projection(original.file,view,at),{format:'svg'});
            const svg=drawing.bytes.toString('utf8');
            if(!/<svg\b/.test(svg)||!/<path\b/.test(svg))throw new Error(prefix+': no native geometry in '+view+' view.');
            const name='handoff/views/'+prefix+'-'+view+'.svg';
            await put(name,drawing.bytes);
            part.views.push({name:view,path:name,at,axes:{top:'X / Y',front:'X / Z',side:'Y / Z'}[view]});
          }
        }
      }
      await fail();
      const selected=report.variants.find(item=>item.id===design.preview.variant).parts.find(item=>item.id===design.preview.part);
      await put('part.stl',await readFile(join(stage,selected.path)));
      const selectedParameters=parametersFor(design,design.variants.find(item=>item.id===design.preview.variant));
      await put('preview.scad','// Generated from the saved design.json; edit the brief or model, then rebuild.\nuse <model.scad>\n'+partCall(design.preview.part,selectedParameters)+'\n');
      for(const variant of report.variants)for(const part of variant.parts)await put('handoff/source-previews/'+variant.id+'-'+part.id+'.scad','use <../../model.scad>\n'+partCall(part.id,variant.parameters)+'\n');
      await put('handoff/checks.json',json(report));
      await put('handoff/index.html',handoff(report));
      await put('handoff/app.js',await readFile(new URL('handoff.js',import.meta.url)));
      const bundle=[...files,...outputs];
      for(const name of ['build.mjs','files.mjs','mesh.mjs','design.mjs','expression.mjs','native.mjs','archive.mjs','handoff.mjs','handoff.js','handoff.css','serve-handoff.mjs','LICENSE'])bundle.push({name:'rebuild/'+name,bytes:await readFile(new URL(name,import.meta.url))});
      bundle.push({name:'REBUILD.md',bytes:Buffer.from('# '+design.title+'\n\nInstall Node 20+ and OpenSCAD (tested '+engine+'). In this extracted folder run:\n\n    node rebuild/build.mjs .\n\nSet OPENSCAD_BIN if needed. No Harness account, npm packages or Python required. Edit design.json for requirements/variant values, model.scad for geometry. All dimensions are millimetres. Compile only trusted SCAD and dependencies; the builder is not a sandbox.\n\nOpen preview.scad in OpenSCAD for the selected editable part. Other saved parameter combinations are in handoff/source-previews/. Downloadable STLs are individually oriented and moved onto the bed; source previews retain design coordinates. The full model and all declared inputs are included.\n\nOpen handoff/index.html locally, or run node rebuild/serve-handoff.mjs . for downloads. The report records the exact source hashes. Rebuild after editing; an old handoff is a saved snapshot, not a live readiness claim. Tools in rebuild/ are MIT-licensed (see rebuild/LICENSE); source permissions remain the creator’s responsibility.\n\n'+limitations.join('\n\n')+'\n')});
      await put('handoff/project.zip',zip(bundle));
      await unchanged(workspace,files);
      report.previousArtifacts=await publish(workspace,state,stage,['part.stl','preview.scad','handoff']);
      await atomic(join(state,'mesh.json'),json(report));
      await verdict({ready:true,artifact:'part.stl',summary:report.variants.length+' variants · '+design.parts.length+' part(s) each · '+report.checks.length+' checks passed · portable project ready',findings:[{severity:'info',kind:'manufacturing',message:limitations.join(' ')}]});
      return report;
    }finally{
      await atomic(join(state,'build.log'),native.log);
    }
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=await build(process.argv[2]||process.env.HARNESS_WORKSPACE||process.cwd());console.log(report.checked?'Ready: '+report.checks.length+' checks. Open handoff/index.html; download handoff/project.zip.':'Legacy geometry preview exported; saved requirements have not been checked.');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
