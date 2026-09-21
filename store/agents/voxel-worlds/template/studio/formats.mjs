import {validateProject,compileWorld,meshWorld,boxesFromCells,clone} from './project.mjs';
const text=new TextEncoder(),decode=new TextDecoder();
const concat=arrays=>{const out=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let offset=0;for(const a of arrays){out.set(a,offset);offset+=a.length;}return out;};
const pad=(array,value=0)=>{const out=new Uint8Array(Math.ceil(array.length/4)*4);out.fill(value);out.set(array);return out;};
const linear=n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
export function selectAsset(project,id){
  const p=clone(project),o=p.objects.find(o=>o.id===id);if(!o)throw new Error('Choose an object to export.');
  const origin=[...o.origin];o.origin=[0,0,0];o.hidden=false;p.objects=[o];p.size=o.rotation%2?[o.size[2],o.size[1],o.size[0]]:[...o.size];
  p.title=o.name;p.id=o.id;p.stops=[];p.spawn={position:[0,0,0],yaw:0};return {project:p,origin};
}
// glTF 2.0 binary: editable named meshes, Y up, meters, explicit sRGB-to-linear materials.
export function exportGLB(project,{objectId}={}){
  let p=validateProject(project);if(objectId)p=selectAsset(p,objectId).project;
  const parts=[],views=[],accessors=[],nodes=[],meshes=[],materials=p.materials.map(m=>{
    const rgb=[1,3,5].map(i=>linear(parseInt(m.color.slice(i,i+2),16)/255));
    return {name:m.name,pbrMetallicRoughness:{baseColorFactor:[...rgb,m.opacity],metallicFactor:0,roughnessFactor:.9},...(m.opacity<1?{alphaMode:'BLEND',doubleSided:true}:{}),...(m.emission?{emissiveFactor:rgb.map(n=>n*m.emission)}:{}),extras:{voxelMaterialId:m.id,solid:m.solid}};
  });let byteOffset=0;
  function accessor(array,type,componentType,target,min,max){const bytes=pad(new Uint8Array(array.buffer));views.push({buffer:0,byteOffset,byteLength:array.byteLength,target});parts.push(bytes);byteOffset+=bytes.length;accessors.push({bufferView:views.length-1,componentType,count:array.length/(type==='VEC3'?3:1),type,...(min?{min,max}:{})});return accessors.length-1;}
  const byObject=new Map();
  for(const group of meshWorld(p)){
    const o=p.objects[group.object],positions=new Float32Array(group.positions.map((v,i)=>(v-o.origin[i%3])*p.unit)),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<positions.length;i++){min[i%3]=Math.min(min[i%3],positions[i]);max[i%3]=Math.max(max[i%3],positions[i]);}
    const primitive={attributes:{POSITION:accessor(positions,'VEC3',5126,34962,min,max),NORMAL:accessor(new Float32Array(group.normals),'VEC3',5126,34962)},indices:accessor(new Uint32Array(group.indices),'SCALAR',5125,34963),material:p.materials.findIndex(m=>m.id===group.material)};
    if(!byObject.has(group.object))byObject.set(group.object,[]);byObject.get(group.object).push(primitive);
  }
  if(!byObject.size)throw new Error('There is no visible geometry to export.');
  for(const [index,primitives]of byObject){const o=p.objects[index];meshes.push({name:o.name,primitives});nodes.push({name:o.name,mesh:meshes.length-1,translation:o.origin.map(n=>n*p.unit),extras:{objectId:o.id,locked:o.locked}});}
  const bin=concat(parts),json=pad(text.encode(JSON.stringify({asset:{version:'2.0',generator:'Tidelands / Voxel Worlds'},scene:0,scenes:[{name:p.title,nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials,buffers:[{byteLength:bin.length}],bufferViews:views,accessors,extras:{brief:p.brief,voxelSizeMeters:p.unit}})),32),header=new Uint8Array(20),v=new DataView(header.buffer),binHeader=new Uint8Array(8),b=new DataView(binHeader.buffer);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,28+json.length+bin.length,true);v.setUint32(12,json.length,true);v.setUint32(16,0x4e4f534a,true);b.setUint32(0,bin.length,true);b.setUint32(4,0x004e4942,true);
  return concat([header,json,binHeader,bin]);
}
function chunk(name,body,children=new Uint8Array()) {const h=new Uint8Array(12),v=new DataView(h.buffer);h.set(text.encode(name));v.setUint32(4,body.length,true);v.setUint32(8,children.length,true);return concat([h,body,children]);}
// MagicaVoxel's vertical axis is Z. Reflect depth while exchanging Y/Z to preserve handedness.
export function exportVOX(project,{objectId}={}){
  let p=validateProject(project);if(objectId)p=selectAsset(p,objectId).project;
  const world=compileWorld(p),[w,h,d]=world.size,size=new Uint8Array(12),s=new DataView(size.buffer),xyzi=new Uint8Array(4+world.count*4),v=new DataView(xyzi.buffer),palette=new Uint8Array(1024);
  s.setUint32(0,w,true);s.setUint32(4,d,true);s.setUint32(8,h,true);v.setUint32(0,world.count,true);let offset=4;
  for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;x++){const id=world.cells[(y*d+z)*w+x];if(id){xyzi.set([x,d-1-z,y,id],offset);offset+=4;}}
  for(const m of p.materials){palette.set([...([1,3,5].map(i=>parseInt(m.color.slice(i,i+2),16))),Math.round(m.opacity*255)],(m.id-1)*4);}
  const header=new Uint8Array(8);header.set(text.encode('VOX '));new DataView(header.buffer).setUint32(4,150,true);
  return concat([header,chunk('MAIN',new Uint8Array(),concat([chunk('SIZE',size),chunk('XYZI',xyzi),chunk('RGBA',palette)]))]);
}
export function importVOX(input){
  const bytes=new Uint8Array(input);if(bytes.length<20||bytes.length>24000000)throw new Error('Choose a .vox file smaller than 24 MB.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),name=(i,n=4)=>decode.decode(bytes.slice(i,i+n));
  if(name(0)!=='VOX '||![150,200].includes(v.getUint32(4,true))||name(8)!=='MAIN')throw new Error('Not a supported MagicaVoxel file.');
  let size,voxels,palette,modelCount=0,offset=20+v.getUint32(12,true),end=offset+v.getUint32(16,true);const nodes=new Map(),hiddenLayers=new Set();
  if(end!==bytes.length)throw new Error('Truncated or trailing VOX data.');
  while(offset<end){if(offset+12>end)throw new Error('Truncated VOX chunk.');const id=name(offset),length=v.getUint32(offset+4,true),children=v.getUint32(offset+8,true),start=offset+12,next=start+length+children;if(next>end)throw new Error('Truncated VOX chunk.');
    if(id==='SIZE'){if(length!==12)throw new Error('Invalid VOX size.');size=[0,4,8].map(n=>v.getUint32(start+n,true));modelCount++;}
    if(id==='XYZI'){if(length<4||v.getUint32(start,true)*4+4!==length||voxels)throw new Error('Use one flattened voxel model.');voxels=bytes.slice(start+4,start+length);}
    if(id==='RGBA'){if(length!==1024)throw new Error('Invalid VOX palette.');palette=bytes.slice(start,start+length);}
    if(['nTRN','nGRP','nSHP','LAYR'].includes(id)){
      let cursor=start;const integer=()=>{if(cursor+4>start+length)throw new Error('Truncated scene transforms.');const n=v.getInt32(cursor,true);cursor+=4;return n;};
      const string=()=>{const n=integer();if(n<0||n>10000||cursor+n>start+length)throw new Error('Invalid VOX scene string.');const s=name(cursor,n);cursor+=n;return s;};
      const dict=()=>{const n=integer();if(n<0||n>64)throw new Error('Invalid VOX scene attributes.');const result=Object.create(null);for(let i=0;i<n;i++)result[string()]=string();return result;};
      const nodeId=integer(),attrs=dict();if(nodeId<0||nodes.size>128)throw new Error('Invalid VOX scene node.');
      if(id==='LAYR'){if(attrs._hidden==='1')hiddenLayers.add(nodeId);integer();}
      else{
        if(nodes.has(nodeId))throw new Error('Duplicate VOX scene node.');const node={id,attrs};
        if(id==='nTRN'){node.child=integer();if(integer()!==-1)throw new Error('Invalid VOX transform.');node.layer=integer();if(integer()!==1)throw new Error('Import a static VOX asset; animated transforms are not supported.');node.frame=dict();}
        if(id==='nGRP'){if(integer()!==1)throw new Error('Import one model instance at a time.');node.child=integer();}
        if(id==='nSHP'){if(integer()!==1||integer()!==0)throw new Error('Import one static voxel model.');dict();}
        nodes.set(nodeId,node);
      }
      if(cursor!==start+length)throw new Error('Unexpected VOX scene data.');
    }
    offset=next;
  }
  if(modelCount!==1||!size||!voxels)throw new Error('Import a single flattened voxel model. Multiple models are not supported.');
  if(!palette)throw new Error('Export the model with its RGBA palette before importing. Default-palette files are not supported.');
  if(size.some(n=>n<1||n>128)||size.reduce((a,b)=>a*b,1)>1048576)throw new Error('Use a model up to 128 cells per axis and one million cells.');
  const transforms=[];
  if(nodes.size){
    const children=new Set([...nodes.values()].map(n=>n.child).filter(n=>n!==undefined)),roots=[...nodes.keys()].filter(n=>!children.has(n));if(roots.length!==1)throw new Error('Invalid or cyclic VOX scene.');let current=roots[0];const visited=new Set();
    while(current!==undefined){if(visited.has(current)||!nodes.has(current))throw new Error('Invalid or cyclic VOX scene.');visited.add(current);const node=nodes.get(current);if(node.attrs._hidden==='1'||hiddenLayers.has(node.layer))throw new Error('The imported asset is hidden in its scene.');
      if(node.id==='nTRN'){const r=Number(node.frame._r??4),a=r&3,b=(r>>2)&3,c=3-a-b;if(!Number.isInteger(r)||r<0||r>127||a>2||b>2||a===b||c<0||c>2)throw new Error('Invalid VOX rotation.');const translation=String(node.frame._t??'0 0 0').trim().split(/\s+/).map(Number);if(translation.length!==3||translation.some(n=>!Number.isInteger(n)||Math.abs(n)>1000000))throw new Error('Invalid VOX translation.');transforms.push({axes:[a,b,c],signs:[4,5,6].map(bit=>r&(1<<bit)?-1:1),translation});}
      current=node.child;
    }
    if(visited.size!==nodes.size||![...nodes.values()].some(n=>n.id==='nSHP'))throw new Error('Import one connected VOX model.');
  }
  const transform=point=>{let q=[...point];for(const t of [...transforms].reverse())q=t.axes.map((axis,i)=>q[axis]*t.signs[i]+t.translation[i]);return q;};
  const corners=[];for(const x of [0,size[0]-1])for(const y of [0,size[1]-1])for(const z of [0,size[2]-1])corners.push(transform([x,y,z]));
  const min=[0,1,2].map(i=>Math.min(...corners.map(p=>p[i]))),dimensions=[0,1,2].map(i=>Math.max(...corners.map(p=>p[i]))-min[i]+1);
  const shape=[dimensions[0],dimensions[2],dimensions[1]],cells=new Uint8Array(shape.reduce((a,b)=>a*b,1)),used=new Set();
  for(let i=0;i<voxels.length;i+=4){const point=[...voxels.slice(i,i+3)],id=voxels[i+3];if(point.some((n,i)=>n>=size[i])||!id)throw new Error('VOX cell outside its declared model.');const [x,z,y]=transform(point).map((n,i)=>n-min[i]),index=(y*shape[2]+shape[2]-1-z)*shape[0]+x;if(cells[index])throw new Error('Duplicate VOX cell.');cells[index]=id;used.add(id);}
  const materials=[...used].sort((a,b)=>a-b).map(id=>{const rgba=palette.slice((id-1)*4,id*4);if(rgba[3]<13)throw new Error('A used VOX material is fully transparent.');return {id,name:'Imported '+id,color:'#'+[...rgba.slice(0,3)].map(n=>n.toString(16).padStart(2,'0')).join(''),opacity:rgba[3]/255,solid:true,emission:0};});
  if(!materials.length)throw new Error('That model contains no voxels.');return {size:shape,cells,materials,boxes:boxesFromCells(cells,shape),source:{format:'vox',transforms,placement:'Oriented model rebased to its own bounds for placement in this world; VOX has no physical scale.'}};
}
export function addImportedAsset(project,asset,{name='Imported asset',origin=[0,0,0]}={}){
  const p=clone(project),mapping=new Map();
  for(const m of asset.materials){let existing=p.materials.find(x=>x.color.toLowerCase()===m.color.toLowerCase()&&Math.abs(x.opacity-m.opacity)<.001&&x.solid===m.solid);if(!existing){const used=new Set(p.materials.map(m=>m.id)),id=Array.from({length:255},(_,i)=>i+1).find(id=>!used.has(id));if(!id)throw new Error('The combined palette exceeds 255 colors.');existing={...m,id};p.materials.push(existing);}mapping.set(m.id,existing.id);}
  let id='imported',n=2;while(p.objects.some(o=>o.id===id))id='imported-'+n++;
  p.objects.push({id,name,size:asset.size,origin,rotation:0,hidden:false,locked:false,boxes:asset.boxes.map(b=>[...b.slice(0,6),mapping.get(b[6])]),edits:[],source:asset.source});return {project:validateProject(p),id};
}
