import {Game,simulate} from './engine.mjs';
import {validateProject,digest} from './project.mjs';
let project,rules,game,revision;
self.onmessage=async({data:{id,type,payload}})=>{try{
 let result;
 if(type==='load'){
   project=validateProject(payload.project);revision=await digest(project);
   const url=URL.createObjectURL(new Blob([project.rules],{type:'text/javascript'}));try{rules=await import(url);}finally{URL.revokeObjectURL(url);}
   game=new Game(project,rules,payload.seed??'first-game');result={...game.view(),revision};
 }else{
   if(!game)throw new Error('Open a game first.');
   if(type==='step')result=game.step(payload.id);
   else if(type==='undo')result=game.undo();
   else if(type==='restart'){game=new Game(project,rules,payload.seed);result=game.view();}
   else if(type==='replay')result={...game.replay(),revision};
   else if(type==='restore'){
     if(payload.revision!==revision)throw new Error('This replay belongs to different rules or components. Open its matching game file.');
     const candidate=new Game(project,rules,payload.seed);result=candidate.restore(payload);game=candidate;
   }else if(type==='simulate')result={...simulate(project,rules,payload),revision};
   else throw new Error('Unknown game operation.');
 }
 self.postMessage({id,result});
}catch(error){self.postMessage({id,error:error.message});}};
