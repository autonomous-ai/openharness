// Inspect commanded single-tool linear FDM motion. This is not firmware simulation.
export function durationSeconds(value){
  if(typeof value!=='string'||!value.trim())throw new Error('Missing slicer time estimate.');
  let total=0,position=0;
  for(const match of value.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)){
    if(value.slice(position,match.index).trim())throw new Error('Unrecognized slicer time estimate.');
    total+=Number(match[1])*({d:86400,h:3600,m:60,s:1}[match[2]]);position=match.index+match[0].length;
  }
  if(value.slice(position).trim()||!position||!Number.isFinite(total))throw new Error('Unrecognized slicer time estimate.');
  return total;
}
function words(text,line,{motion=false}={}){
  const result=Object.create(null);let end=0;
  for(const match of text.matchAll(/([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)){
    if(motion&&text.slice(end,match.index).trim())throw new Error('Unsupported motion syntax at line '+line);
    const key=match[1],value=Number(match[2]);
    if(motion&&(!'XYZEF'.includes(key)||Object.hasOwn(result,key)))throw new Error('Unsupported or duplicate motion word at line '+line);
    if(!Number.isFinite(value)||Math.abs(value)>1e7)throw new Error('Invalid coordinate at line '+line);
    result[key]=value;end=match.index+match[0].length;
  }
  if(motion&&text.slice(end).trim())throw new Error('Unsupported motion syntax at line '+line);
  return result;
}
const extent=()=>({min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]});
const include=(bounds,point)=>point.forEach((v,i)=>{bounds.min[i]=Math.min(bounds.min[i],v);bounds.max[i]=Math.max(bounds.max[i],v);});
export function parseGcode(source){
  if(typeof source!=='string'||new TextEncoder().encode(source).length>32*1024*1024)throw new Error('G-code must be text under 32 MiB.');
  const layers=[],map=new Map(),features=[],warnings=new Set(),motions=[],temperatures=[],settings=Object.create(null),commands=Object.create(null);
  let pos=[0,0,0],offset=[0,0,0],e=0,debt=0,absolute=true,absoluteE=true,unit=1,feed=0,feature='Custom',lineNumber=0;
  let modelExtrusionMm=0,commandedExtrusionMm=0,travelMM=0,depositionMM=0,config=false,configBlocks=0,configEnds=0,lastDepositionLine=0;
  const thermal={nozzle:null,bed:null};let lastExtrusionLine=0;const extrusionTemperatures=[];
  const stats={time:null,timeSeconds:null,filamentMm:null,filamentGrams:null,filamentCm3:null,sourceLayers:null};
  const bounds=extent(),modelBounds=extent(),motionBounds=extent();
  const layerAt=z=>{
    const key=Math.round(z*10000)/10000;
    if(!map.has(key)){const layer={z:key,segments:[],indices:[],extrusionMm:0,modelExtrusionMm:0};map.set(key,layer);layers.push(layer);}
    return map.get(key);
  };
  for(const raw of source.split(/\r?\n/)){
    lineNumber++;
    if(/^;\s*CONFIG_BLOCK_START\s*$/.test(raw)){if(config)throw new Error('Nested settings block.');config=true;configBlocks++;continue;}
    if(/^;\s*CONFIG_BLOCK_END\s*$/.test(raw)){if(!config)throw new Error('Settings block ended without a start.');config=false;configEnds++;continue;}
    if(config){
      const match=raw.match(/^;\s*([a-zA-Z0-9_]+)\s*=\s?(.*)$/);
      if(match){
        const key=match[1],value=match[2].trim(),prior=settings[key],numeric=/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
        // Orca 2.4.2 repeats wipe-tower coordinates as e.g. 15.000 and 15.
        // Equivalent duplicates are harmless; contradictory settings are not.
        if(Object.hasOwn(settings,key)&&prior!==value&&!(numeric.test(prior)&&numeric.test(value)&&Number(prior)===Number(value)))throw new Error('Conflicting duplicate emitted setting: '+key);
        settings[key]=value;
      }
      else if(raw.trim()&&!raw.trim().startsWith(';'))throw new Error('Executable code inside settings block.');
      continue;
    }
    let match=raw.match(/^;\s*(?:TYPE|FEATURE):\s*(.+)/i);if(match)feature=match[1].trim();
    match=raw.match(/^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)/i);if(match){stats.time=match[1].trim();stats.timeSeconds=durationSeconds(stats.time);}
    match=raw.match(/^;\s*(?:total layer number:|total layers count\s*=)\s*(\d+)/i);if(match)stats.sourceLayers=Number(match[1]);
    for(const [unitName,key] of [['mm','filamentMm'],['g','filamentGrams'],['cm3','filamentCm3']]){
      const found=raw.match(new RegExp('^;\\s*(?:total )?filament used \\['+unitName+'\\]\\s*=\\s*([\\d.]+)\\s*$','i'));
      if(found){const value=Number(found[1]);if(!Number.isFinite(value)||value<0)throw new Error('Invalid filament estimate.');stats[key]=value;}
    }
    let code=raw.split(';')[0].replace(/\([^)]*\)/g,'').trim().toUpperCase();if(!code)continue;
    if(code.includes('*'))throw new Error('Serial checksums are not supported; export plain G-code.');
    code=code.replace(/^N\d+\s*/,'');
    const token=code.match(/^([GMT])(\d+(?:\.\d+)?)(?=\s|[A-Z+-]|$)/);
    if(!token)throw new Error('Unmodeled macro/command at line '+lineNumber+': '+code.split(/\s/)[0]);
    const command=token[1]+Number(token[2]),tail=code.slice(token[0].length);
    if(!commands[command])commands[command]={count:0,firstLine:lineNumber};
    commands[command].count++;
    if(command==='G20'){unit=25.4;continue;}if(command==='G21'){unit=1;continue;}
    if(command==='G90'){absolute=true;absoluteE=true;continue;}if(command==='G91'){absolute=false;absoluteE=false;continue;}
    if(command==='M82'){absoluteE=true;continue;}if(command==='M83'){absoluteE=false;continue;}
    if(['G2','G3','G5'].includes(command))throw new Error('Curved moves at line '+lineNumber+' are not modeled. Disable arc fitting and re-slice.');
    if(['G10','G11','G53','G54','G55','G56','G57','G58','G59','G68','G69','G92.1','M206','M218','M32','M98','M125','M600','M601','M605','M701','M702'].includes(command))throw new Error(command+' changes unmodeled motion, extrusion or control flow at line '+lineNumber+'. Use explicit linear, single-origin G-code.');
    if(command.startsWith('G')&&!['G0','G1','G4','G17','G18','G19','G20','G21','G28','G29','G80','G90','G91','G92'].includes(command))throw new Error('Unsupported motion command '+command+' at line '+lineNumber);
    if(command.startsWith('T')&&command!=='T0')throw new Error('Multiple tools are not modeled. Use a single-tool G-code file.');
    if(command==='G28'){
      // The preview assumes homed axes have machine coordinate zero. Real home
      // offsets and leveling are firmware properties, not proven by this parser.
      const axes=['X','Y','Z'],requested=axes.filter(axis=>tail.includes(axis));
      for(const axis of requested.length?requested:axes){const index=axes.indexOf(axis);pos[index]=0;offset[index]=0;}
      warnings.add('Homing is drawn at zero; firmware home offsets and bed leveling are not modeled.');continue;
    }
    if(['G29','G80','M290','M220','M221','M900'].includes(command))warnings.add('Firmware leveling, flow/speed overrides and pressure advance are not simulated.');
    const linear=['G0','G1','G92'].includes(command);
    const params=words(tail,lineNumber,{motion:linear});
    if(command==='M200'&&params.D!==undefined&&params.D!==0)throw new Error('Volumetric E coordinates are not supported.');
    if(['M104','M109','M140','M190'].includes(command)){
      if(params.T!==undefined&&params.T!==0)throw new Error('Multiple heater tools are not supported.');
      const target=params.S??params.R;
      if(target!==undefined){
        const heater=['M104','M109'].includes(command)?'nozzle':'bed';
        if(target<0||target>1000)throw new Error('Invalid heater target at line '+lineNumber);
        thermal[heater]=target;temperatures.push({line:lineNumber,command,heater,target,wait:['M109','M190'].includes(command)});
      }
    }
    if(command==='G92'){
      for(const [i,axis] of ['X','Y','Z'].entries())if(params[axis]!==undefined)offset[i]=pos[i]-params[axis]*unit;
      if(params.E!==undefined)e=params.E*unit;continue;
    }
    if(!['G0','G1'].includes(command))continue;
    if(params.F!==undefined){feed=params.F*unit;if(feed<0)throw new Error('Negative feed at line '+lineNumber);}
    const next=pos.map((value,i)=>params[['X','Y','Z'][i]]===undefined?value:absolute?params[['X','Y','Z'][i]]*unit+offset[i]:value+params[['X','Y','Z'][i]]*unit);
    const nextE=params.E===undefined?e:absoluteE?params.E*unit:e+params.E*unit,deltaE=nextE-e;
    if([...next,nextE,feed].some(v=>!Number.isFinite(v)||Math.abs(v)>1e7))throw new Error('Invalid coordinate at line '+lineNumber);
    let deposited=0;
    if(deltaE<0)debt-=deltaE;
    if(deltaE>0){const recovery=Math.min(debt,deltaE);debt-=recovery;deposited=deltaE-recovery;commandedExtrusionMm+=deposited;}
    if(deposited>.00001){lastExtrusionLine=lineNumber;if(!extrusionTemperatures.some(item=>item.nozzle===thermal.nozzle&&item.bed===thermal.bed))extrusionTemperatures.push({...thermal,line:lineNumber});}
    const distance=Math.hypot(...next.map((v,i)=>v-pos[i]));
    if(distance>.00001){
      if(motions.length>=1000000)throw new Error('Inspection supports at most 1,000,000 linear moves.');
      const extrude=deposited>.00001;
      if(!features.includes(feature))features.push(feature);
      // Layout retained for the renderer: XYZ start/end, mm/s, feature, deposition, source line.
      const segment=[...pos,...next,feed/60,features.indexOf(feature),extrude?1:0,lineNumber,deposited];
      const layer=layerAt(next[2]);layer.indices.push(motions.length);layer.segments.push(segment);motions.push(segment);
      include(motionBounds,pos);include(motionBounds,next);
      if(extrude){
        lastDepositionLine=lineNumber;depositionMM+=distance;layer.extrusionMm+=deposited;
        include(bounds,pos);include(bounds,next);
        if(feature!=='Custom'){modelExtrusionMm+=deposited;layer.modelExtrusionMm+=deposited;include(modelBounds,pos);include(modelBounds,next);}
        if(feed===0)warnings.add('A deposition move has no known positive feed.');
      }else travelMM+=distance;
    }
    pos=next;e=nextE;
  }
  if(config||configBlocks!==configEnds||configBlocks>1)throw new Error('Incomplete or repeated emitted settings block.');
  const printed=layers.filter(layer=>layer.extrusionMm>0).sort((a,b)=>a.z-b.z);
  if(!printed.length)throw new Error('No linear extrusion paths found.');
  if(layers.some(layer=>layer.extrusionMm===0))warnings.add('Travel-only heights are outside the print-layer list; use the full-motion view to include Z hops and final parking.');
  return {layers:printed,features,bounds,modelBounds:Number.isFinite(modelBounds.min[0])?modelBounds:bounds,motionBounds,motions,
    stats,moves:motions.length,warnings:[...warnings],lines:lineNumber,settings,configBlocks,commands,temperatures,thermal,lastDepositionLine,lastExtrusionLine,extrusionTemperatures,
    modelLayers:printed.filter(layer=>layer.modelExtrusionMm>0).length,modelExtrusionMm,commandedExtrusionMm,travelMM,depositionMM};
}
