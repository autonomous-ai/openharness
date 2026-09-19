import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCircuit, simulate, probabilities } from './engine.mjs';

export async function build(workspace) {
  const directory=fileURLToPath(new URL('.',import.meta.url));
  await mkdir(join(workspace,'.harness'),{recursive:true});
  const atomic=async(file,text)=>{
    const temporary=file+'.'+process.pid+'.tmp';
    await writeFile(temporary,text);await rename(temporary,file);
  };
  const verdict=async(value)=>atomic(join(workspace,'.harness/verdict.json'),JSON.stringify({
    spec:1,...value,updatedAt:new Date().toISOString()
  },null,2)+'\n');
  try{
    await verdict({ready:false,summary:'Checking circuit and rebuilding the simulator',findings:[],artifact:null});
    const circuit=validateCircuit(JSON.parse(await readFile(join(workspace,'circuit.json'),'utf8')));
    const state=simulate(circuit);
    const [shell,engine,app]=await Promise.all(['studio.html','engine.mjs','studio.js'].map(file=>readFile(join(directory,file),'utf8')));
    // Escape '<', including </script>, even in a non-executable JSON script element.
    const payload=JSON.stringify(circuit).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
    const html=shell.replace('<!--CIRCUIT-->',()=>payload)
      .replace('<!--ENGINE-->',()=>engine.replace(/^export /gm,''))
      .replace('<!--APP-->',()=>app);
    await atomic(join(workspace,'index.html'),html);
    const summary='Statevector verified — '+circuit.qubits.length+' qubits, '+circuit.gates.length+' gates';
    await verdict({ready:true,summary,findings:[],artifact:'index.html'});
    return {circuit,probabilities:probabilities(state),summary};
  }catch(error){
    await verdict({ready:false,summary:'Circuit build failed',findings:[{severity:'error',kind:'circuit',message:error.message}],artifact:null});
    throw error;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log((await build(resolve(process.env.HARNESS_WORKSPACE || process.cwd()))).summary);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
