// Inspect the exported mesh, not OpenSCAD's exit code. Coordinates are millimetres.
export function inspectSTL(buffer) {
  const triangles=[];
  if(buffer.length>=84 && buffer.readUInt32LE(80)*50+84===buffer.length){
    for(let i=84;i<buffer.length;i+=50)triangles.push([0,1,2].map(v=>[0,1,2].map(axis=>buffer.readFloatLE(i+12+v*12+axis*4))));
  }else{
    const source=buffer.toString('utf8');
    if(!/^\s*solid\b/.test(source)||!/endsolid\b/.test(source))throw new Error('The export is not a complete STL.');
    const vertices=[...source.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)].map(match=>match.slice(1).map(Number));
    if(vertices.length%3)throw new Error('The STL has an incomplete triangle.');
    for(let i=0;i<vertices.length;i+=3)triangles.push(vertices.slice(i,i+3));
  }
  if(!triangles.length)throw new Error('The STL is empty.');
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],edges=new Map();
  let signedVolume=0,area=0,degenerateTriangles=0;
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  for(const vertices of triangles){
    if(vertices.some(point=>point.some(value=>!Number.isFinite(value))))throw new Error('The STL contains non-finite coordinates.');
    for(const point of vertices)point.forEach((value,axis)=>{min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);});
    const [a,b,c]=vertices,normal=cross(b.map((v,i)=>v-a[i]),c.map((v,i)=>v-a[i])),faceArea=Math.hypot(...normal)/2;
    area+=faceArea;if(faceArea<1e-10)degenerateTriangles++;
    const bc=cross(b,c);signedVolume+=a.reduce((sum,value,i)=>sum+value*bc[i],0)/6;
    const keys=vertices.map(point=>point.map(value=>value.toFixed(5)).join(','));
    for(let i=0;i<3;i++){
      const a=keys[i],b=keys[(i+1)%3],key=a<b?a+'|'+b:b+'|'+a;
      const edge=edges.get(key)||{count:0,balance:0};edge.count++;edge.balance+=a<b?1:-1;edges.set(key,edge);
    }
  }
  const nonManifoldEdges=[...edges.values()].filter(edge=>edge.count!==2||edge.balance!==0).length;
  return {triangles:triangles.length,bounds:{min,max,size:max.map((v,i)=>v-min[i])},volumeMM3:Math.abs(signedVolume),areaMM2:area,degenerateTriangles,nonManifoldEdges,watertight:!nonManifoldEdges&&!degenerateTriangles};
}
