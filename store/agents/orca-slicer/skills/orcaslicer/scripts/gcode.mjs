// Linear FDM toolpaths, in millimetres. Rendering is inspection, not printer validation.
export function parseGcode(source){
  if(typeof source!=='string'||source.length>32*1024*1024)throw new Error('G-code must be text under 32 MiB.');
  const layers=[],map=new Map(),features=[],warnings=new Set();
  let pos=[0,0,0],offset=[0,0,0],e=0,absolute=true,absoluteE=true,unit=1,feed=0,feature='Custom',lineNumber=0,moves=0;
  const stats={time:null,filamentMm:null,filamentGrams:null,sourceLayers:null};
  const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  const modelBounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  const layerAt=z=>{const key=Math.round(z*10000)/10000;if(!map.has(key)){const layer={z:key,segments:[],extrusionMm:0};map.set(key,layer);layers.push(layer);}return map.get(key);};
  for(const raw of source.split(/\r?\n/)){
    lineNumber++;
    let match=raw.match(/^;\s*(?:TYPE|FEATURE):\s*(.+)/i);if(match)feature=match[1].trim();
    match=raw.match(/^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)/i);if(match)stats.time=match[1].trim();
    match=raw.match(/^;\s*total layer number:\s*(\d+)/i);if(match)stats.sourceLayers=Number(match[1]);
    match=raw.match(/^;\s*total filament used \[mm\]\s*=\s*([\d.]+)/i);if(match)stats.filamentMm=Number(match[1]);
    match=raw.match(/^;\s*total filament used \[g\]\s*=\s*([\d.]+)/i);if(match)stats.filamentGrams=Number(match[1]);
    const code=raw.split(';')[0].replace(/\([^)]*\)/g,'').trim().toUpperCase();if(!code)continue;
    const command=code.match(/^(?:N\d+\s*)?([GMT]\d+(?:\.\d+)?)/)?.[1];if(!command)continue;
    const params=Object.fromEntries([...code.matchAll(/([XYZEF])\s*([-+]?(?:\d*\.)?\d+)/g)].map(m=>[m[1],Number(m[2])]));
    if(command==='G20'){unit=25.4;continue;}if(command==='G21'){unit=1;continue;}
    if(command==='G90'){absolute=true;absoluteE=true;continue;}if(command==='G91'){absolute=false;absoluteE=false;continue;}
    if(command==='M82'){absoluteE=true;continue;}if(command==='M83'){absoluteE=false;continue;}
    if(command==='G92'){for(const [i,axis]of ['X','Y','Z'].entries())if(params[axis]!==undefined)offset[i]=pos[i]-params[axis]*unit;if(params.E!==undefined)e=params.E*unit;continue;}
    if(['G2','G02','G3','G03','G5'].includes(command))throw new Error('Curved moves at line '+lineNumber+' are not modeled. Disable arc fitting and re-slice.');
    if(command==='G28'){warnings.add('Homing assumed to establish the machine origin; firmware offsets and bed leveling are not modeled.');continue;}
    if(/^T\d/.test(command)&&command!=='T0')throw new Error('Multiple tools are not modeled. Use a single-tool G-code file.');
    if(!['G0','G00','G1','G01'].includes(command))continue;
    if(params.F!==undefined)feed=params.F*unit;
    const next=pos.map((value,i)=>params[['X','Y','Z'][i]]===undefined?value:absolute?params[['X','Y','Z'][i]]*unit+offset[i]:value+params[['X','Y','Z'][i]]*unit);
    const nextE=params.E===undefined?e:absoluteE?params.E*unit:e+params.E*unit,deltaE=nextE-e;
    if([...next,nextE,feed].some(v=>!Number.isFinite(v)||Math.abs(v)>1e7))throw new Error('Invalid coordinate at line '+lineNumber);
    if(Math.hypot(...next.map((v,i)=>v-pos[i]))>0.00001){
      if(++moves>250000)throw new Error('Preview supports at most 250,000 linear moves.');
      const extrude=deltaE>0.00001;
      if(!features.includes(feature))features.push(feature);
      const layer=layerAt(next[2]);
      layer.segments.push([...pos,...next,feed/60,features.indexOf(feature),extrude?1:0,lineNumber]);
      if(extrude){layer.extrusionMm+=deltaE;for(const point of [pos,next])for(let i=0;i<3;i++){bounds.min[i]=Math.min(bounds.min[i],point[i]);bounds.max[i]=Math.max(bounds.max[i],point[i]);if(feature!=='Custom'){modelBounds.min[i]=Math.min(modelBounds.min[i],point[i]);modelBounds.max[i]=Math.max(modelBounds.max[i],point[i]);}}}
    }
    pos=next;e=nextE;
  }
  const printed=layers.filter(layer=>layer.extrusionMm>0).sort((a,b)=>a.z-b.z);
  if(!printed.length)throw new Error('No linear extrusion paths found.');
  if(layers.some(layer=>layer.extrusionMm===0))warnings.add('Travel-only heights are omitted from the layer list (including Z hops and final parking).');
  return {layers:printed,features,bounds,modelBounds:Number.isFinite(modelBounds.min[0])?modelBounds:bounds,stats,moves,warnings:[...warnings],lines:lineNumber};
}
