import {number,vector} from './expression.mjs';
const idPattern=/^[a-z][a-z0-9-]{0,31}$/;
const variablePattern=/^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/;
function fields(value,allowed,label) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(label+' must be an object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error('Unknown '+label+' field: '+key);
}
function text(value,label,max=2000) {
  if (typeof value!=='string' || !value.trim() || value.length>max || /[\x00-\x08\x0b-\x1f]/.test(value)) throw new Error('Invalid '+label);
}
function list(value,label) {
  if (!Array.isArray(value) || value.length>30) throw new Error(label+' must be a list of at most 30 notes.');
  for (const item of value) text(item,label,1000);
}
function integer(value,min,max,label) {
  if (!Number.isInteger(value) || value<min || value>max) throw new Error(label+' must be an integer from '+min+' to '+max);
}
function ids(list,label) {
  if (!Array.isArray(list)) throw new Error(label+' must be a list.');
  const result=new Set();
  for (const item of list) {
    if (!item || !idPattern.test(item.id) || result.has(item.id)) throw new Error('Invalid or duplicate '+label+' ID.');
    result.add(item.id);
  }
  return result;
}
export function parametersFor(design,variant) {
  const parameters=Object.create(null);
  for (const [name,definition] of Object.entries(design.parameters)) {
    const value=Object.hasOwn(variant.values,name)?variant.values[name]:definition.value;
    number(value,{},name);
    if (typeof value!=='number' || value<definition.min || value>definition.max || definition.unit==='count'&&!Number.isInteger(value)) throw new Error(variant.id+': '+name+' is outside its saved limits.');
    parameters[name]=value;
  }
  for (const name of Object.keys(variant.values)) if (!Object.hasOwn(parameters,name)) throw new Error('Unknown variant parameter: '+name);
  return parameters;
}
export function regionFor(raw,parameters) {
  fields(raw,['shape','origin','size','radius','height','axis','repeat'],'region');
  const origin=vector(raw.origin,parameters,'Region origin');
  let region;
  if (raw.shape==='box') {
    if (['radius','height','axis'].some(key=>raw[key]!==undefined)) throw new Error('A box uses size, not cylinder fields.');
    region={shape:'box',origin,size:vector(raw.size,parameters,'Region size',{positive:true})};
  } else if (raw.shape==='cylinder') {
    if (raw.size!==undefined || !['x','y','z'].includes(raw.axis||'z')) throw new Error('Invalid cylinder region.');
    const radius=number(raw.radius,parameters,'Region radius'),height=number(raw.height,parameters,'Region height');
    if (radius<=0 || height<=0) throw new Error('Cylinder radius and height must be positive.');
    region={shape:'cylinder',origin,radius,height,axis:raw.axis||'z'};
  } else throw new Error('Region shape must be box or cylinder.');
  let copies=[origin];
  if (raw.repeat!==undefined) {
    if (!Array.isArray(raw.repeat) || raw.repeat.length>2) throw new Error('Use up to two repeat axes for a region.');
    for (const repeat of raw.repeat) {
      fields(repeat,['count','step'],'region repeat');
      const count=number(repeat.count,parameters,'Repeat count'),step=vector(repeat.step,parameters,'Repeat step');
      integer(count,1,32,'Region repeat count');
      if (copies.length*count>64) throw new Error('A region can contain at most 64 repeated probes.');
      copies=copies.flatMap(point=>Array.from({length:count},(_,i)=>point.map((value,axis)=>value+i*step[axis])));
    }
  }
  region.origins=copies; return region;
}
export function regionScad(region) {
  const literal=value=>JSON.stringify(value);
  const primitive=region.shape==='box'?'cube('+literal(region.size)+');':
    (region.axis==='x'?'rotate([0,90,0]) ':region.axis==='y'?'rotate([-90,0,0]) ':'')+'cylinder(r='+region.radius+',h='+region.height+',$fn=128);';
  return 'union() {\n'+region.origins.map(origin=>'translate('+literal(origin)+') '+primitive).join('\n')+'\n}';
}
export function checkFor(check,parameters) {
  const result={...check};
  if (check.kind==='bounds') {
    result.size=vector(check.size,parameters,'Required size',{positive:true});
    result.origin=vector(check.origin,parameters,'Required origin');
    result.tolerance=number(check.tolerance??.02,parameters,'Bounds tolerance');
    if (result.tolerance<=0 || result.tolerance>1) throw new Error('Bounds tolerance must be greater than zero and no more than 1 mm.');
  }
  if (check.kind==='volume') {
    if (!Array.isArray(check.range) || check.range.length!==2) throw new Error('Volume range needs minimum and maximum.');
    result.range=check.range.map(value=>number(value,parameters,'Volume limit'));
    if (result.range[0]<=0 || result.range[1]<result.range[0]) throw new Error('Invalid volume range.');
  }
  if (['empty','contains'].includes(check.kind)) result.region=regionFor(check.region,parameters);
  if (check.kind==='separated') {
    result.translation=vector(check.translation||[0,0,0],parameters,'Second part translation');
    result.rotation=vector(check.rotation||[0,0,0],parameters,'Second part rotation');
  }
  return result;
}
export function validateDesign(input) {
  const design=structuredClone(input);
  fields(design,['spec','title','brief','assumptions','assembly','sourceFiles','parameters','variants','parts','checks','process','preview'],'design');
  if (design.spec!==1) throw new Error('design.json requires spec: 1.');
  text(design.title,'title',100);text(design.brief,'brief',4000);
  list(design.assumptions,'Assumptions');list(design.assembly,'Assembly/use instructions');
  if (!Array.isArray(design.sourceFiles) || !design.sourceFiles.includes('model.scad') || !design.sourceFiles.includes('design.json') || design.sourceFiles.length>32) throw new Error('sourceFiles must include model.scad and design.json, with at most 32 files.');
  const names=new Set();
  for (const name of design.sourceFiles) {
    if (typeof name!=='string' || name.length>180 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name.split('/').some(component=>!component || component.startsWith('.')) || !/\.(scad|json|stl|svg|dxf|txt|md)$/i.test(name) || /^(handoff|rebuild)(\/|$)/i.test(name) || /^(part\.stl|preview\.scad|rebuild\.md)$/i.test(name)) throw new Error('Unsafe or reserved source path: '+name);
    if (names.has(name.toLowerCase())) throw new Error('Duplicate source path: '+name);
    names.add(name.toLowerCase());
  }
  if (!design.parameters || typeof design.parameters!=='object' || Array.isArray(design.parameters) || !Object.keys(design.parameters).length || Object.keys(design.parameters).length>64) throw new Error('Use 1–64 named numeric parameters.');
  for (const [name,definition] of Object.entries(design.parameters)) {
    if (!variablePattern.test(name) || name==='id' || name.startsWith('harness_')) throw new Error('Invalid or reserved parameter name: '+name);
    fields(definition,['value','min','max','unit','label'],'parameter '+name);
    for (const field of ['value','min','max']) if (typeof definition[field]!=='number') throw new Error(name+' '+field+' must be a number.');
    number(definition.min);number(definition.max);number(definition.value);
    if (definition.unit==='count'&&!Number.isInteger(definition.value)) throw new Error(name+' default count must be an integer.');
    if (definition.min>definition.max || definition.value<definition.min || definition.value>definition.max || !['mm','degrees','count','ratio'].includes(definition.unit)) throw new Error('Invalid limits, default or unit for '+name);
    if (definition.label!==undefined) text(definition.label,'parameter label',100);
  }
  const variants=ids(design.variants,'variant'),parts=ids(design.parts,'part');
  integer(variants.size,1,4,'Variants');integer(parts.size,1,8,'Parts');
  const exportNames=new Set();
  for (const variant of variants) for (const part of parts) {
    const name=variant+'-'+part;
    if (exportNames.has(name)) throw new Error('Ambiguous variant/part export name: '+name+'. Choose distinct IDs.');
    exportNames.add(name);
  }
  for (const variant of design.variants) {
    fields(variant,['id','label','values','notes'],'variant');
    text(variant.label,'variant label',100);list(variant.notes,'Variant notes');
    if (!variant.values || typeof variant.values!=='object' || Array.isArray(variant.values)) throw new Error('Variant values must be an object.');
  }
  for (const part of design.parts) {
    fields(part,['id','label','quantity','printRotation','shells','views','notes'],'part');
    text(part.label,'part label',100);list(part.notes,'Part notes');
    integer(part.quantity,1,100,'Part quantity');integer(part.shells,1,16,'Expected connected surface shells');
    part.printRotation=vector(part.printRotation,{},'Print rotation');
    fields(part.views,['top','front','side'],'part views');
    for (const name of ['top','front','side']) {
      fields(part.views[name],['at'],'view '+name);
      // at=null is an external silhouette; a numeric expression is a section.
      if (part.views[name].at===undefined) throw new Error('Each view declares at (section plane), or null for a silhouette.');
    }
  }
  fields(design.preview,['variant','part'],'preview');
  if (!variants.has(design.preview.variant)||!parts.has(design.preview.part)) throw new Error('Preview must name an exported variant and part.');
  fields(design.process,['material','bedMM','edgeMarginMM','nozzleMM','notes'],'process');
  text(design.process.material,'material',100);list(design.process.notes,'Process notes');
  design.process.bedMM=vector(design.process.bedMM,{},'Printer build envelope',{positive:true});
  design.process.edgeMarginMM=number(design.process.edgeMarginMM);design.process.nozzleMM=number(design.process.nozzleMM);
  if (design.process.edgeMarginMM<0 || design.process.nozzleMM<=0) throw new Error('Review edge margin and nozzle diameter.');
  const checks=ids(design.checks,'check');integer(checks.size,1,32,'Checks');
  const checkNames=new Set();
  for (const variant of variants) {
    for (const name of [...checks,...[...parts].flatMap(part=>['topology','reopen','bed'].map(suffix=>part+'-'+suffix))]) {
      const id=variant+'-'+name;
      if (checkNames.has(id)) throw new Error('Duplicate or reserved generated check ID: '+id);
      checkNames.add(id);
    }
  }
  const permitted={
    bounds:['size','origin','tolerance'],volume:['range'],empty:['region'],contains:['region'],separated:['other','translation','rotation']
  };
  for (const check of design.checks) {
    if (!Object.hasOwn(permitted,check.kind)) throw new Error('Unknown check kind: '+check.kind);
    fields(check,['id','label','kind','part',...permitted[check.kind]],'check '+check.id);
    text(check.label,'check label',200);
    if (!parts.has(check.part) || check.kind==='separated' && (!parts.has(check.other) || check.other===check.part)) throw new Error('Check names an unknown or identical second part.');
  }
  for (const part of design.parts) if (!design.checks.some(check=>check.part===part.id && check.kind==='bounds')) throw new Error('Every part needs a saved bounds requirement: '+part.id);
  for (const variant of design.variants) {
    const parameters=parametersFor(design,variant);
    for (const part of design.parts) for (const view of Object.values(part.views)) if (view.at!==null) number(view.at,parameters,'Section position');
    for (const check of design.checks) checkFor(check,parameters);
  }
  return design;
}
