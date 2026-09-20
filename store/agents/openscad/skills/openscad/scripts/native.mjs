import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';

// Parse OpenSCAD's make-style dependency output, including escaped spaces.
export function dependencies(text) {
  const joined=text.replace(/\\\r?\n/g,'');
  const separator=joined.indexOf(': ');
  if (separator<0) throw new Error('Invalid OpenSCAD dependency receipt.');
  const result=[];let token='',escaped=false;
  for (const char of joined.slice(separator+2)) {
    if (escaped) {token+=char;escaped=false;}
    else if (char==='\\') escaped=true;
    else if (/\s/.test(char)) {if(token){result.push(token);token='';}}
    else token+=char;
  }
  if (escaped) throw new Error('Incomplete dependency path.');
  if(token)result.push(token);
  if(!result.length)throw new Error('Empty OpenSCAD dependency receipt.');
  return result;
}
export class Native {
  constructor(bin,directory) {this.bin=bin;this.directory=directory;this.log='';this.serial=0;this.started=Date.now();}
  version() {
    const result=spawnSync(this.bin,['--version'],{cwd:this.directory,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    const output=(result.stdout||'')+(result.stderr||'');this.log+=output;
    if(result.error||result.status!==0||!/^OpenSCAD version /m.test(output))throw new Error('OpenSCAD could not report its version: '+(result.error?.message||output));
    return output.trim().split('\n')[0];
  }
  async render(label,code,{format='stl',emptyAllowed=false,allowedDependencies}={}) {
    if(!/^[a-zA-Z0-9-]+$/.test(label)||!['stl','svg'].includes(format))throw new Error('Invalid native export request.');
    if(Date.now()-this.started>600000)throw new Error('The checked build exceeded ten minutes. Simplify or split the variant batch.');
    const name=String(++this.serial).padStart(3,'0')+'-'+label;
    const source=join(this.directory,name+'.scad'),output=join(this.directory,name+'.'+format),deps=join(this.directory,name+'.deps');
    await writeFile(source,code);
    const args=['-o',output,'--hardwarnings','--check-parameters','true','--check-parameter-ranges','true'];
    if(format==='stl')args.push('--export-format','binstl');
    if(allowedDependencies)args.push('-d',deps);
    args.push(source);
    const result=spawnSync(this.bin,args,{cwd:this.directory,encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
    const message=(result.stdout||'')+(result.stderr||'');
    this.log+='\n--- '+name+' ---\n'+message;
    if(result.error)throw new Error(label+': '+result.error.message);
    // An unknown module or an assertion can also produce "empty". Those are
    // failures, never successful clearance/containment proofs.
    if(/^\s*(?:ERROR|WARNING):/m.test(message))throw new Error(label+': OpenSCAD diagnostic; see .harness/build.log.');
    let info;
    try {info=await lstat(output);}catch(error){if(error.code!=='ENOENT')throw error;}
    const empty=/^Current top level object is empty\.\s*$/m.test(message);
    if(emptyAllowed && result.status===1 && empty && (!info || info.isFile()&&info.size===0))return {empty:true,bytes:null,file:null};
    if(result.status!==0||empty||!info?.isFile()||info.isSymbolicLink()||!info.size)throw new Error(label+': no fresh '+format.toUpperCase()+' export (exit '+result.status+'). See .harness/build.log.');
    if(info.size>64*1024*1024)throw new Error(label+': native export exceeds 64 MiB.');
    if(allowedDependencies){
      const permitted=new Set(await Promise.all([...allowedDependencies,source].map(path=>realpath(path))));
      for(const path of dependencies(await readFile(deps,'utf8'))){
        const actual=await realpath(resolve(this.directory,path));
        if(!permitted.has(actual))throw new Error('Model read an undeclared dependency: '+path+'. Include it in sourceFiles and use a relative path.');
      }
    }
    return {empty:false,file:output,bytes:await readFile(output)};
  }
}

export function partCall(id,parameters) {
  return 'part(id='+JSON.stringify(id)+Object.entries(parameters).map(([name,value])=>','+name+'='+JSON.stringify(value)).join('')+');';
}
export function imported(path) {
  return 'import('+JSON.stringify(path.replaceAll('\\','/'))+');';
}
export function projection(mesh,view,at) {
  const transform=view==='top'?'':view==='front'?'rotate([-90,0,0]) ':'multmatrix([[0,1,0,0],[0,0,1,0],[1,0,0,0],[0,0,0,1]]) ';
  const translation=view==='top'?[0,0,-(at||0)]:view==='front'?[0,-(at||0),0]:[-(at||0),0,0];
  return 'projection(cut='+(at!==null)+') '+transform+(at===null?'':'translate('+JSON.stringify(translation)+') ')+imported(mesh);
}
