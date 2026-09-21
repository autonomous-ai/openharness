import {inspectSTL,parseSTL,binarySTL} from './mesh.mjs';
import {isDeepStrictEqual} from 'node:util';
const fail=message=>{throw new Error(message);};
function obj(value,label,keys){if(!value||Array.isArray(value)||typeof value!=='object')fail(label+' must be an object.');for(const key of Object.keys(value))if(!keys.includes(key))fail('Unknown '+label+' field: '+key);}
function str(value,label){if(typeof value!=='string'||!value.trim()||value.length>2000)fail(label+' must be nonempty text under 2000 characters.');}
function num(value,label,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(label+' must be between '+min+' and '+max+'.');}
function array(value,label,n){if(!Array.isArray(value)||value.length!==n)fail(label+' needs '+n+' values.');}
export function pathName(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))fail('Use a safe workspace-relative path: '+value);return value;}
export function validateConfig(c){
 if(c?.spec!==1)fail('Save a spec: 1 slicing brief. Legacy demo/custom configs are not checked projects; see the current template.');
 obj(c,'brief',['spec','title','brief','assumptions','sourceFiles','profiles','machine','model','plans','selectedPlan','limits']);
 for(const k of ['title','brief','assumptions'])str(c[k],k);
 if(!Array.isArray(c.sourceFiles)||!c.sourceFiles.length||c.sourceFiles.length>32)fail('Declare 1–32 sourceFiles.');
 c.sourceFiles.forEach(pathName);if(new Set(c.sourceFiles.map(v=>v.toLowerCase())).size!==c.sourceFiles.length)fail('Duplicate source files.');
 if(!c.sourceFiles.includes('slice-config.json'))fail('sourceFiles must include slice-config.json.');
 if(c.sourceFiles.some(n=>/^(?:plans|handoff|rebuild|\.harness)\//.test(n)||/^(?:preview\.html|part\.(?:gcode|3mf))$/.test(n)))fail('Source files cannot be generated output paths.');
 obj(c.profiles,'profiles',['source','printer','process','filament']);if(!['installed','workspace'].includes(c.profiles.source))fail('profiles.source must be installed or workspace.');
 for(const k of ['printer','process','filament']){
  const path=c.profiles[k];
  if(c.profiles.source==='installed'){if(typeof path!=='string'||!path||/[;:\\\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('Installed profiles must be relative paths inside the Orca profiles directory.');}
  else {pathName(path);if(!c.sourceFiles.includes(path))fail('Declare each workspace profile in sourceFiles.');}
 }
 obj(c.machine,'machine',['context','label','printerModel','nozzleMM','bedMM','bedType','firmware','material','nozzleTemperatureRange','bedTemperatureRange']);
 const m=c.machine;if(!['example','user'].includes(m.context))fail('machine.context must explicitly be example or user.');
 for(const k of ['label','printerModel','material'])str(m[k],'machine.'+k);
 if(!['marlin','marlin2'].includes(m.firmware))fail('This checked workflow currently supports single-tool Marlin / Marlin 2 only, without named macros.');
 if(!['High Temp Plate','Textured PEI Plate','Cool Plate','Engineering Plate'].includes(m.bedType))fail('Declare a supported explicit bedType.');
 num(m.nozzleMM,'nozzleMM',.1,2);array(m.bedMM,'bedMM',3);m.bedMM.forEach(v=>num(v,'bedMM',10,2000));
 for(const [key,max] of [['nozzleTemperatureRange',400],['bedTemperatureRange',150]]){array(m[key],key,2);m[key].forEach(v=>num(v,key,1,max));if(m[key][0]>m[key][1])fail('Temperature ranges must be ordered.');}
 obj(c.model,'model',['path','expectedSizeMM','toleranceMM','rotationDegrees','scale']);pathName(c.model.path);
 if(!c.model.path.endsWith('.stl')||!c.sourceFiles.includes(c.model.path))fail('Declare one source STL in sourceFiles.');
 array(c.model.expectedSizeMM,'expectedSizeMM',3);c.model.expectedSizeMM.forEach(v=>num(v,'expectedSizeMM',.01,2000));
 num(c.model.toleranceMM,'toleranceMM',.0001,1);num(c.model.scale,'scale',.001,100);
 array(c.model.rotationDegrees,'rotationDegrees',3);c.model.rotationDegrees.forEach(v=>num(v,'rotationDegrees',-360,360));
 obj(c.limits,'limits',['maxTimeSeconds','maxFilamentGrams','bedMarginMM']);num(c.limits.maxTimeSeconds,'maxTimeSeconds',1,604800);num(c.limits.maxFilamentGrams,'maxFilamentGrams',.01,20000);num(c.limits.bedMarginMM,'bedMarginMM',0,50);
 if(!Array.isArray(c.plans)||c.plans.length<1||c.plans.length>4)fail('Compare 1–4 plans.');const ids=new Set();
 for(const p of c.plans){
  obj(p,'plan',['id','label','description','layerHeightMM','firstLayerMM','wallLoops','infillPercent','infillPattern','topLayers','bottomLayers','supports','brimMM']);
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(p.id)||ids.has(p.id))fail('Use unique lowercase plan ids.');ids.add(p.id);str(p.label,'plan label');str(p.description,'plan description');
  for(const k of ['layerHeightMM','firstLayerMM'])num(p[k],k,.03,m.nozzleMM*.8);
  for(const k of ['wallLoops','topLayers','bottomLayers']){num(p[k],k,1,30);if(!Number.isInteger(p[k]))fail(k+' must be an integer.');}
  num(p.infillPercent,'infillPercent',0,100);num(p.brimMM,'brimMM',0,30);
  if(!['gyroid','rectilinear','grid','crosshatch'].includes(p.infillPattern))fail('Unsupported infill pattern.');
  if(typeof p.supports!=='boolean')fail('supports must be true or false.');
 }
 if(!ids.has(c.selectedPlan))fail('selectedPlan must name a saved plan.');return c;
}
export function planSettings(p){return {
 layer_height:String(p.layerHeightMM),initial_layer_print_height:String(p.firstLayerMM),wall_loops:String(p.wallLoops),
 sparse_infill_density:p.infillPercent+'%',sparse_infill_pattern:p.infillPattern,top_shell_layers:String(p.topLayers),bottom_shell_layers:String(p.bottomLayers),
 top_shell_thickness:'0',bottom_shell_thickness:'0',enable_support:p.supports?'1':'0',brim_width:String(p.brimMM),brim_type:p.brimMM?'outer_only':'no_brim',
 enable_arc_fitting:'0',post_process:[],spiral_mode:'0',infill_combination:'0',enable_prime_tower:'0',print_sequence:'by layer'
};}
// Orca 2.4.2 sometimes materializes this absent preset-catalog metadata as [].
// No numerical, G-code, geometry or slicing setting is ignored.
export function canonicalReopenSettings(settings){return {...settings,upward_compatible_machine:settings.upward_compatible_machine??[]};}
export function assertMesh(mesh,label){if(!mesh.watertight||mesh.orientedVolumeMM3<=0||mesh.shells.some(s=>s.orientedVolumeMM3<=0))fail(label+' must have closed, consistently oriented positive-volume shells. Repair the mesh first.');}
export function prepareModel(bytes,c){
 const input=inspectSTL(bytes);assertMesh(input,'Source STL');
 input.bounds.size.forEach((n,i)=>{if(Math.abs(n-c.model.expectedSizeMM[i])>c.model.toleranceMM)fail('Source size disagrees with the saved millimetre brief on axis '+i+': '+n);});
 const radians=c.model.rotationDegrees.map(v=>v*Math.PI/180);
 const triangles=parseSTL(bytes).map(face=>face.map(original=>{
  let p=original.map(v=>v*c.model.scale);
  for(let axis=0;axis<3;axis++){const a=(axis+1)%3,b=(axis+2)%3,x=p[a],y=p[b];p[a]=x*Math.cos(radians[axis])-y*Math.sin(radians[axis]);p[b]=x*Math.sin(radians[axis])+y*Math.cos(radians[axis]);}
  return p;
 }));
 const first=inspectSTL(binarySTL(triangles)),oriented=binarySTL(triangles,first.bounds.min.map(v=>-v)),mesh=inspectSTL(oriented);assertMesh(mesh,'Oriented STL');
 for(let i=0;i<3;i++)if(mesh.bounds.size[i]+(i<2?2*(c.limits.bedMarginMM+Math.max(...c.plans.map(p=>p.brimMM))):0)>c.machine.bedMM[i])fail('Oriented model plus requested brim/margin exceeds the declared bed.');
 return {input,mesh,bytes:oriented};
}
export function assertProfiles(profiles,c){
 for(const [kind,type] of [['printer','machine'],['process','process'],['filament','filament']]){
  const p=profiles[kind];if(p.type!==type)fail(kind+' profile has the wrong type.');
  if(p.post_process?.length)fail('Remove post_process commands from profiles. This workflow never runs post-processors.');
 }
 const p=profiles.printer,m=c.machine;
 if(p.printer_model!==m.printerModel||p.gcode_flavor!==m.firmware)fail('Printer model/firmware does not match the saved brief.');
 if(!Array.isArray(p.nozzle_diameter)||p.nozzle_diameter.length!==1||Number(p.nozzle_diameter[0])!==m.nozzleMM)fail('Exactly one nozzle matching the saved diameter is required.');
 const points=(p.printable_area||[]).map(v=>v.split('x').map(Number));
 const expected=[[0,0],[m.bedMM[0],0],[m.bedMM[0],m.bedMM[1]],[0,m.bedMM[1]]];
 if(points.length!==4||points.some(v=>!expected.some(e=>isDeepStrictEqual(v,e)))||new Set(points.map(v=>v.join(','))).size!==4||Number(p.printable_height)!==m.bedMM[2])fail('Printer bed must match the declared zero-origin rectangular build volume.');
 if(p.bed_exclude_area?.some(v=>v!=='0x0'))fail('Nonempty bed exclusion zones are not supported by this checked workflow.');
 if(profiles.filament.filament_type?.length!==1||profiles.filament.filament_type[0]!==m.material)fail('Filament type must match the brief.');
 for(const plan of c.plans)for(const value of [plan.layerHeightMM,plan.firstLayerMM])if(value<Number(p.min_layer_height?.[0]||.03)||value>Number(p.max_layer_height?.[0]||m.nozzleMM*.8))fail('Layer height is outside this printer profile’s range.');
}
export function inspectPlan(parsed,effective,c,plan,mesh){
 const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass,detail});if(!pass)fail(plan.id+': '+name+' — '+detail);};
 const scalar=v=>Array.isArray(v)?v.join(';'):String(v??'');
 check('One complete emitted settings block',parsed.configBlocks===1,'CONFIG_BLOCK_START / END');
 const required={...planSettings(plan),curr_bed_type:c.machine.bedType,printer_model:c.machine.printerModel,gcode_flavor:c.machine.firmware,nozzle_diameter:[String(c.machine.nozzleMM)],printable_height:String(c.machine.bedMM[2]),filament_type:[c.machine.material]};
 for(const [key,value] of Object.entries(required)){
  check('Effective '+key,scalar(effective[key])===scalar(value),'expected '+scalar(value)+', got '+scalar(effective[key]));
  check('Emitted '+key,scalar(parsed.settings[key])===scalar(value),'G-code setting agrees with saved brief');
 }
 const area=['0x0',c.machine.bedMM[0]+'x0',c.machine.bedMM[0]+'x'+c.machine.bedMM[1],'0x'+c.machine.bedMM[1]];
 check('Effective bed polygon',isDeepStrictEqual(effective.printable_area,area),'zero-origin rectangular area agrees with the saved brief');
 check('Emitted bed polygon',parsed.settings.printable_area===area.join(','),'G-code agrees with the saved bed');
 const excluded=effective.bed_exclude_area||[];
 check('No effective bed exclusions',Array.isArray(excluded)&&excluded.every(v=>v==='0x0')&&['','0x0'].includes(parsed.settings.bed_exclude_area??''),'no unsupported exclusion zone was applied');
 const bedKeys={'High Temp Plate':'hot_plate_temp','Textured PEI Plate':'textured_plate_temp','Cool Plate':'cool_plate_temp','Engineering Plate':'eng_plate_temp'};
 for(const [heater,keys,range] of [['nozzle',['nozzle_temperature','nozzle_temperature_initial_layer'],c.machine.nozzleTemperatureRange],['bed',[bedKeys[c.machine.bedType],bedKeys[c.machine.bedType]+'_initial_layer'],c.machine.bedTemperatureRange]]){
  for(const key of keys){const values=effective[key];check('Profile '+key,Array.isArray(values)&&values.length===1&&Number(values[0])>=range[0]&&Number(values[0])<=range[1],scalar(values));check('Emitted '+key,scalar(parsed.settings[key])===scalar(values),'matches effective profile');}
  const commands=parsed.temperatures.filter(t=>t.heater===heater),active=commands.filter(t=>t.target>0);
  check(heater+' heater commands within saved range',active.length>0&&active.every(t=>t.target>=range[0]&&t.target<=range[1]),JSON.stringify(commands));
  check(heater+' targets at extrusion',parsed.extrusionTemperatures.length>0&&parsed.extrusionTemperatures.every(t=>t[heater]>=range[0]&&t[heater]<=range[1]),'commanded targets only, not measured temperatures');
  check(heater+' heater off after final extrusion',parsed.thermal[heater]===0&&commands.at(-1)?.line>parsed.lastExtrusionLine,'last command must be zero after all extrusion');
 }
 check('Positive feeds',parsed.motions.filter(s=>s[8]).every(s=>s[6]>0),'every deposition move has a positive commanded speed');
 check('Reported model layers agree',parsed.stats.sourceLayers===parsed.modelLayers,parsed.modelLayers+' measured model heights; '+parsed.stats.sourceLayers+' reported');
 check('Top height agrees with mesh',Math.abs(parsed.modelBounds.max[2]-mesh.bounds.size[2])<=Math.max(plan.layerHeightMM,plan.firstLayerMM)+.02,parsed.modelBounds.max[2]+' mm');
 check('First layer agrees',Math.abs(parsed.layers.filter(l=>l.modelExtrusionMm>0)[0].z-plan.firstLayerMM)<.001,plan.firstLayerMM+' mm');
 const b=parsed.modelBounds,margin=c.limits.bedMarginMM;
 check('Model/support centerlines inside bed inset',[0,1].every(i=>b.min[i]>=margin&&b.max[i]<=c.machine.bedMM[i]-margin)&&b.min[2]>=0&&b.max[2]<=c.machine.bedMM[2],JSON.stringify(b));
 check('Time budget',Number.isFinite(parsed.stats.timeSeconds)&&parsed.stats.timeSeconds>0&&parsed.stats.timeSeconds<=c.limits.maxTimeSeconds,parsed.stats.time+' (slicer estimate)');
 check('Material budget',Number.isFinite(parsed.stats.filamentGrams)&&parsed.stats.filamentGrams>0&&parsed.stats.filamentGrams<=c.limits.maxFilamentGrams,parsed.stats.filamentGrams+' g (slicer estimate)');
 return checks;
}
