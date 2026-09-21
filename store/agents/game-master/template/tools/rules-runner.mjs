import {parentPort,workerData} from 'node:worker_threads';
import {Game,simulate} from '../studio/engine.mjs';
import {canonical,validateProject,digest} from '../studio/project.mjs';
try{
 const project=validateProject(workerData.project),rules=await import('data:text/javascript;base64,'+Buffer.from(project.rules).toString('base64'));
 if(workerData.operation==='initial'){const game=new Game(project,rules);parentPort.postMessage({ok:true,view:game.view()});}
 else{
  const options=workerData.options??{},a=simulate(project,rules,options),b=simulate(project,rules,options);
  if(canonical(a)!==canonical(b))throw new Error('The same rules, policy and seeds produced different outcomes.');
  if(a.errors||a.capped)throw new Error(`${a.errors} rule errors and ${a.capped} games reached the turn cap.`);
  for(const row of a.games){const game=new Game(project,rules,row.seed);game.restore(row.replay);}
  parentPort.postMessage({ok:true,report:{...a,revision:await digest(project),repeated:true,replaysVerified:true}});
 }
}catch(error){parentPort.postMessage({ok:false,error:error.message});}
