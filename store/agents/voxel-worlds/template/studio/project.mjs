// Editable, named voxel objects. Empty cells are zero; material IDs are 1–255.
export const SPEC = 'tidelands/2';
export const clone = value => structuredClone(value);
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const finite = (v,lo,hi) => Number.isFinite(v) && v >= lo && v <= hi;
const ints = (a,n,lo,hi) => Array.isArray(a) && a.length === n && a.every(v => Number.isInteger(v) && finite(v,lo,hi));
const words = (v,n) => typeof v === 'string' && v.length <= n;
export function rotatedSize(object) { return object.rotation % 2 ? [object.size[2],object.size[1],object.size[0]] : [...object.size]; }
export function localToWorld(object,x,y,z) {
  const [w,,d] = object.size;
  const [a,c] = [[x,z],[d-1-z,x],[w-1-x,d-1-z],[z,w-1-x]][object.rotation];
  return [a+object.origin[0],y+object.origin[1],c+object.origin[2]];
}
export function worldToLocal(object,x,y,z) {
  x-=object.origin[0];y-=object.origin[1];z-=object.origin[2];const [w,,d]=object.size;
  const [a,c]=[[x,z],[z,d-1-x],[w-1-x,d-1-z],[w-1-z,x]][object.rotation];return [a,y,c];
}
export function validateProject(input) {
  const p=clone(input);
  if(!p || p.spec!==SPEC || !idPattern.test(p.id))throw new Error('Open a Tidelands world project.');
  if(!words(p.title,120)||!p.title.trim()||!words(p.brief,12000))throw new Error('Give the world a title and brief.');
  if(!ints(p.size,3,4,128)||p.size.reduce((a,b)=>a*b,1)>1048576)throw new Error('Use a world up to 128 cells per side and one million cells.');
  if(!finite(p.unit,0.01,10))throw new Error('Set the real size of one voxel in meters.');
  if(!Array.isArray(p.materials)||!p.materials.length||p.materials.length>255)throw new Error('Use 1–255 materials.');
  const materials=new Set([0]);
  for(const m of p.materials){
    if(!Number.isInteger(m.id)||!finite(m.id,1,255)||materials.has(m.id)||!words(m.name,80)||!/^#[0-9a-f]{6}$/i.test(m.color))throw new Error('Materials need unique numeric IDs, names and hex colors.');
    materials.add(m.id);m.solid??=true;m.opacity??=1;m.emission??=0;
    if(typeof m.solid!=='boolean'||!finite(m.opacity,.05,1)||!finite(m.emission,0,1))throw new Error('Invalid material solidity, opacity or emission.');
  }
  if(!Array.isArray(p.objects)||!p.objects.length||p.objects.length>128)throw new Error('Use 1–128 named objects.');
  let volume=0,paint=0,commands=0;const ids=new Set();
  for(const o of p.objects){
    if(!idPattern.test(o.id)||ids.has(o.id)||!words(o.name,120))throw new Error('Give every object a unique ID and a name.');ids.add(o.id);
    if(!ints(o.size,3,1,128)||!ints(o.origin,3,0,127))throw new Error('Object dimensions and origins must be whole voxel coordinates.');
    o.rotation??=0;o.hidden??=false;o.locked??=false;o.edits??=[];
    if(!Number.isInteger(o.rotation)||!finite(o.rotation,0,3)||typeof o.hidden!=='boolean'||typeof o.locked!=='boolean')throw new Error('Invalid object orientation or visibility.');
    if(rotatedSize(o).some((n,i)=>o.origin[i]+n>p.size[i]))throw new Error(`${o.name} extends outside the world. Move it inward or enlarge the world.`);
    volume+=o.size.reduce((a,b)=>a*b,1);
    if(!Array.isArray(o.boxes)||!Array.isArray(o.edits))throw new Error('Object geometry needs boxes and cell edits.');
    for(const b of o.boxes){
      if(!ints(b,7,0,255)||b.slice(3,6).some(n=>!n)||b.slice(0,3).some((n,i)=>n+b[i+3]>o.size[i])||!materials.has(b[6]))throw new Error(`Invalid voxel box in ${o.name}.`);
      paint+=b[3]*b[4]*b[5];commands++;
    }
    for(const e of o.edits){if(!ints(e,4,0,255)||e.slice(0,3).some((n,i)=>n>=o.size[i])||!materials.has(e[3]))throw new Error(`Invalid cell edit in ${o.name}.`);commands++;}
  }
  if(volume>8388608||paint>16777216||commands>100000)throw new Error('This project exceeds the editing budget. Split it into related worlds or assets.');
  const position = v => Array.isArray(v)&&v.length===3&&v.every((n,i)=>finite(n,0,p.size[i]));
  if(!p.spawn||!position(p.spawn.position)||!finite(p.spawn.yaw,-Math.PI*2,Math.PI*2))throw new Error('Place the visitor start inside the world.');
  p.stops??=[];if(!Array.isArray(p.stops)||p.stops.length>30)throw new Error('Use at most 30 tour stops.');
  const stopIds=new Set();for(const s of p.stops){if(!idPattern.test(s.id)||stopIds.has(s.id)||!words(s.name,120)||!words(s.description,2000)||!position(s.position))throw new Error('Invalid tour stop.');stopIds.add(s.id);}
  p.notes??='';if(!words(p.notes,12000))throw new Error('Keep project notes under 12,000 characters.');
  p.light??=.32;if(!finite(p.light,0,1))throw new Error('Choose a light setting from 0 to 1.');
  if(JSON.stringify(p).length>12000000)throw new Error('Keep the editable project under 12 MB.');
  return p;
}
export function objectCells(object) {
  const [w,h,d]=object.size,cells=new Uint8Array(w*h*d),at=(x,y,z)=>(y*d+z)*w+x;
  for(const [x,y,z,sx,sy,sz,id]of object.boxes)for(let j=y;j<y+sy;j++)for(let k=z;k<z+sz;k++)cells.fill(id,at(x,j,k),at(x+sx,j,k));
  for(const [x,y,z,id]of object.edits)cells[at(x,y,z)]=id;
  return cells;
}
export function compileWorld(p) {
  const [w,h,d]=p.size,cells=new Uint8Array(w*h*d),owners=new Uint16Array(cells.length),materials=new Map(p.materials.map(m=>[m.id,m]));
  let count=0;const counts=new Map();
  for(let i=0;i<p.objects.length;i++){
    const o=p.objects[i];if(o.hidden)continue;const local=objectCells(o),[ow,oh,od]=o.size;
    for(let y=0;y<oh;y++)for(let z=0;z<od;z++)for(let x=0;x<ow;x++){
      const id=local[(y*od+z)*ow+x];if(!id)continue;const [wx,wy,wz]=localToWorld(o,x,y,z),n=(wy*d+wz)*w+wx;
      cells[n]=id;owners[n]=i+1;
    }
  }
  for(const id of cells)if(id){count++;counts.set(id,(counts.get(id)||0)+1);}
  return {size:p.size,unit:p.unit,cells,owners,materials,count,counts};
}
export function cellAt(world,x,y,z) { const [w,h,d]=world.size;return x<0||y<0||z<0||x>=w||y>=h||z>=d?0:world.cells[(y*d+z)*w+x]; }
export function isSolid(world,x,y,z){return world.materials.get(cellAt(world,x,y,z))?.solid??false;}
export const faces = [
  {n:[1,0,0],v:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]},
  {n:[-1,0,0],v:[[0,0,1],[0,1,1],[0,1,0],[0,0,0]]},
  {n:[0,1,0],v:[[0,1,1],[1,1,1],[1,1,0],[0,1,0]]},
  {n:[0,-1,0],v:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]},
  {n:[0,0,1],v:[[1,0,1],[1,1,1],[0,1,1],[0,0,1]]},
  {n:[0,0,-1],v:[[0,0,0],[0,1,0],[1,1,0],[1,0,0]]},
];
export function meshWorld(p,world=compileWorld(p)) {
  const groups=new Map(),[w,h,d]=world.size;let faceCount=0;
  for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;x++){
    const index=(y*d+z)*w+x,id=world.cells[index];if(!id)continue;const owner=world.owners[index]-1,key=owner+':'+id;
    for(const f of faces){
      const next=cellAt(world,x+f.n[0],y+f.n[1],z+f.n[2]);if(next&&(next===id||world.materials.get(next).opacity===1))continue;
      if(++faceCount>350000)throw new Error('This scene has too many exposed voxel faces. Simplify scattered geometry or split it into assets.');
      if(!groups.has(key))groups.set(key,{object:owner,material:id,positions:[],normals:[],indices:[]});const g=groups.get(key),base=g.positions.length/3;
      for(const v of f.v){g.positions.push(x+v[0],y+v[1],z+v[2]);g.normals.push(...f.n);}g.indices.push(base,base+1,base+2,base,base+2,base+3);
    }
  }
  return [...groups.values()];
}
export function paintCells(p,objectId,worldPosition,material,radius=0,{existingOnly=false}={}) {
  const o=p.objects.find(o=>o.id===objectId);if(!o||o.locked)throw new Error('Choose an unlocked object to sculpt.');
  if(o.rotation){
    const old=objectCells(o),[w,h,d]=o.size,nextSize=rotatedSize(o),next=new Uint8Array(nextSize.reduce((a,b)=>a*b,1));
    for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;x++){const [a,b,c]=localToWorld(o,x,y,z).map((n,i)=>n-o.origin[i]);next[(b*nextSize[2]+c)*nextSize[0]+a]=old[(y*d+z)*w+x];}
    o.size=nextSize;o.rotation=0;o.boxes=boxesFromCells(next,nextSize);o.edits=[];
  }
  if(material!==0&&!existingOnly){
    const lower=worldPosition.map((n,i)=>Math.max(-o.origin[i],Math.min(0,n-o.origin[i]-radius)));
    const upper=worldPosition.map((n,i)=>Math.min(p.size[i]-o.origin[i],Math.max(o.size[i],n-o.origin[i]+radius+1)));
    for(const b of o.boxes)for(let i=0;i<3;i++)b[i]-=lower[i];for(const e of o.edits)for(let i=0;i<3;i++)e[i]-=lower[i];
    o.size=upper.map((n,i)=>n-lower[i]);o.origin=o.origin.map((n,i)=>n+lower[i]);
  }
  const center=worldToLocal(o,...worldPosition),edits=new Map(o.edits.map(e=>[e.slice(0,3).join(','),e])),before=existingOnly?objectCells(o):null;let changed=0;
  for(let y=-radius;y<=radius;y++)for(let z=-radius;z<=radius;z++)for(let x=-radius;x<=radius;x++){
    const at=[center[0]+x,center[1]+y,center[2]+z];if(at.some((n,i)=>n<0||n>=o.size[i]))continue;
    if(before&&!before[(at[1]*o.size[2]+at[2])*o.size[0]+at[0]])continue;
    edits.set(at.join(','),[...at,material]);changed++;
  }
  o.edits=[...edits.values()];return changed;
}
export function boxesFromCells(cells,size){
  const [w,h,d]=size,boxes=[];
  for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;){const id=cells[(y*d+z)*w+x],start=x++;while(x<w&&cells[(y*d+z)*w+x]===id)x++;if(id)boxes.push([start,y,z,x-start,1,1,id]);}
  return boxes;
}
export function fitsVisitor(world,position) {
  const [x,y,z]=position,r=.26/world.unit,height=1.7/world.unit;
  if(x-r<0||z-r<0||x+r>world.size[0]||z+r>world.size[2]||y<0||y+height>world.size[1])return false;
  for(let a=Math.floor(x-r);a<=Math.floor(x+r-.0001);a++)for(let b=Math.floor(y+.0001);b<=Math.floor(y+height-.0001);b++)for(let c=Math.floor(z-r);c<=Math.floor(z+r-.0001);c++)if(isSolid(world,a,b,c))return false;
  return true;
}
export function moveVisitor(world,visitor,input,dt=1/60) {
  const p=clone(visitor);let dx=Math.sin(p.yaw)*(input.forward||0)-Math.cos(p.yaw)*(input.right||0),dz=Math.cos(p.yaw)*(input.forward||0)+Math.sin(p.yaw)*(input.right||0);
  const speed=(input.sprint?5:3)/world.unit,normal=Math.max(1,Math.hypot(dx,dz));dx=dx/normal*speed*dt;dz=dz/normal*speed*dt;
  for(const [axis,delta]of [[0,dx],[2,dz]]){
    const next=[...p.position];next[axis]+=delta;
    if(fitsVisitor(world,next))p.position=next;
    else if(p.grounded){for(let step=1;step<=Math.ceil(.45/world.unit);step++){next[1]=Math.floor(p.position[1])+step;if(next[1]-p.position[1]>.45/world.unit+.001)break;if(fitsVisitor(world,next)){p.position=next;break;}}}
  }
  if(input.jump&&p.grounded)p.velocity=4/world.unit;
  p.velocity=(p.velocity||0)-9.8/world.unit*dt;const vertical=[...p.position];vertical[1]+=p.velocity*dt;
  if(fitsVisitor(world,vertical)){p.position=vertical;p.grounded=false;}
  else{
    let low=0,high=1;const delta=vertical[1]-p.position[1];
    for(let i=0;i<12;i++){const middle=(low+high)/2,candidate=[...p.position];candidate[1]+=delta*middle;if(fitsVisitor(world,candidate))low=middle;else high=middle;}
    p.position[1]+=delta*low;if(p.velocity<0)p.grounded=true;p.velocity=0;
  }
  return p;
}
export function navigationReport(p,world=compileWorld(p)) {
  const issues=[],height=1.7/p.unit,step=.45/p.unit,drop=1/p.unit,[w,h,d]=p.size,surfaces=new Map();
  for(let z=0;z<d;z++)for(let x=0;x<w;x++){
    const ys=[];for(let y=1;y+height<=h;y++)if(isSolid(world,x,y-1,z)&&!isSolid(world,x,y,z)&&fitsVisitor(world,[x+.5,y,z+.5]))ys.push(y);
    if(ys.length)surfaces.set(x+','+z,ys);
  }
  const start=p.spawn.position.map(Math.floor),startHeights=surfaces.get(start[0]+','+start[2])??[],sy=startHeights.find(y=>Math.abs(y-p.spawn.position[1])<.2);
  if(sy===undefined||!fitsVisitor(world,p.spawn.position))issues.push('The visitor start has no clear standing space.');
  const visited=new Set(),queue=[];if(sy!==undefined){start[1]=sy;queue.push(start);visited.add(start.join(','));}
  for(let i=0;i<queue.length;i++){
    const [x,y,z]=queue[i];for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]])for(const ny of surfaces.get((x+dx)+','+(z+dz))??[]){
      if(ny-y>step+.001||y-ny>drop+.001)continue;const next=[x+dx,ny,z+dz],key=next.join(',');if(!visited.has(key)){visited.add(key);queue.push(next);}
    }
  }
  const stops=p.stops.map(s=>{const [x,y,z]=s.position,reachable=[...surfaces.get(Math.floor(x)+','+Math.floor(z))??[]].some(ny=>Math.abs(y-ny)<.2&&visited.has([Math.floor(x),ny,Math.floor(z)].join(',')));if(!reachable)issues.push(`${s.name} is not connected to the visitor start by the checked walking routes.`);return {id:s.id,reachable};});
  return {spawnClear:sy!==undefined&&fitsVisitor(world,p.spawn.position),reachableStandingCells:visited.size,stops,issues,method:'Cardinal standing-cell search with visitor clearance, 0.45 m steps and 1 m descents; actual browser walking still required.'};
}
