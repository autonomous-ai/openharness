// Inspect exported triangles, not a compiler exit code. All coordinates are mm.
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function parseSTL(input) {
  const buffer=Buffer.from(input),triangles=[];
  if(buffer.length>64*1024*1024)throw new Error('STL exceeds 64 MiB.');
  if(buffer.length>=84 && buffer.readUInt32LE(80)*50+84===buffer.length){
    if(buffer.readUInt32LE(80)>1000000)throw new Error('STL exceeds one million triangles.');
    for(let i=84;i<buffer.length;i+=50)triangles.push([0,1,2].map(v=>[0,1,2].map(axis=>buffer.readFloatLE(i+12+v*12+axis*4))));
  }else{
    const source=buffer.toString('utf8');
    if(!/^\s*solid\b/.test(source)||!/endsolid\b/.test(source))throw new Error('The export is not a complete STL.');
    const vertices=[];
    for(const match of source.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)){
      vertices.push(match.slice(1).map(Number));
      if(vertices.length>3000000)throw new Error('STL exceeds one million triangles.');
    }
    if(vertices.length%3)throw new Error('The STL has an incomplete triangle.');
    for(let i=0;i<vertices.length;i+=3)triangles.push(vertices.slice(i,i+3));
  }
  if(!triangles.length)throw new Error('The STL is empty.');
  if(triangles.some(face=>face.some(point=>point.some(value=>!Number.isFinite(value)||Math.abs(value)>1e8))))throw new Error('STL coordinates must be finite and within ±100,000,000 mm.');
  return triangles;
}
export function inspectTriangles(triangles) {
  if(!triangles.length)throw new Error('The STL is empty.');
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],edges=new Map();
  const parents=Array.from({length:triangles.length},(_,i)=>i);
  const root=index=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index];}return index;};
  let signedVolume=0,area=0,degenerateTriangles=0;
  const volumes=[];
  for(const [index,vertices] of triangles.entries()){
    for(const point of vertices)point.forEach((value,axis)=>{min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);});
    const [a,b,c]=vertices,normal=cross(b.map((v,i)=>v-a[i]),c.map((v,i)=>v-a[i])),faceArea=Math.hypot(...normal)/2;
    area+=faceArea;if(faceArea<1e-10)degenerateTriangles++;
    const bc=cross(b,c),volume=a.reduce((sum,value,i)=>sum+value*bc[i],0)/6;signedVolume+=volume;volumes.push(volume);
    // Normalize -0 so welding does not split a face across the origin.
    const keys=vertices.map(point=>point.map(value=>Number(value.toFixed(5))).join(','));
    for(let i=0;i<3;i++){
      const a=keys[i],b=keys[(i+1)%3],key=a<b?a+'|'+b:b+'|'+a;
      const edge=edges.get(key)||{count:0,balance:0,face:index};
      edge.count++;edge.balance+=a<b?1:-1;edges.set(key,edge);
      parents[root(index)]=root(edge.face);
    }
  }
  const nonManifoldEdges=[...edges.values()].filter(edge=>edge.count!==2||edge.balance!==0).length;
  const shells=new Map();
  triangles.forEach((_face,index)=>{
    const id=root(index),shell=shells.get(id)||{triangles:0,orientedVolumeMM3:0};
    shell.triangles++;shell.orientedVolumeMM3+=volumes[index];shells.set(id,shell);
  });
  return {triangles:triangles.length,bounds:{min,max,size:max.map((v,i)=>v-min[i])},volumeMM3:Math.abs(signedVolume),orientedVolumeMM3:signedVolume,areaMM2:area,degenerateTriangles,nonManifoldEdges,watertight:!nonManifoldEdges&&!degenerateTriangles,shells:[...shells.values()]};
}
export function inspectSTL(buffer) {return inspectTriangles(parseSTL(buffer));}
export function binarySTL(triangles,translation=[0,0,0]) {
  if(!triangles.length||triangles.length>1000000)throw new Error('Invalid triangle count.');
  const buffer=Buffer.alloc(84+triangles.length*50);buffer.write('OpenHarness / millimetres / actual exported geometry');buffer.writeUInt32LE(triangles.length,80);
  triangles.forEach((face,index)=>{
    const [a,b,c]=face,normal=cross(b.map((v,i)=>v-a[i]),c.map((v,i)=>v-a[i])),length=Math.hypot(...normal);
    for(let axis=0;axis<3;axis++)buffer.writeFloatLE(length?normal[axis]/length:0,84+index*50+axis*4);
    face.forEach((point,vertex)=>point.forEach((value,axis)=>buffer.writeFloatLE(value+translation[axis],84+index*50+12+vertex*12+axis*4)));
  });
  return buffer;
}
