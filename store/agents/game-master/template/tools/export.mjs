#!/usr/bin/env node
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readProject,buildGame,toolsDirectory} from './build.mjs';
import {kitFiles,boardSVG,esc} from '../studio/formats.mjs';
import {zipFiles} from '../studio/archive.mjs';
import {checkRules} from './check.mjs';
export async function exportGame(workspace,destination,{project:provided,pdf=true}={}){
 const root=resolve(workspace),out=resolve(destination),project=provided??await readProject(root);await checkRules(project,{},'initial');const {html}=await buildGame(root,{project});const files=kitFiles(project,html);await mkdir(out,{recursive:true});
 for(const [name,body] of Object.entries(files)){const file=join(out,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,body);}
 if(pdf){
  const tools=await toolsDirectory(),{chromium}=await import(pathToFileURL(join(tools,'node_modules/playwright-core/index.mjs')).href),{browserPath}=await import(pathToFileURL(join(tools,'browser.mjs')).href);const browser=await chromium.launch({executablePath:await browserPath(),headless:true});
  try{const page=await browser.newPage();for(const name of ['components','rulebook']){await page.goto(pathToFileURL(join(out,'print',name+'.html')).href);await page.pdf({path:join(out,'print',name+'.pdf'),printBackground:true,preferCSSPageSize:true});files['print/'+name+'.pdf']=await readFile(join(out,'print',name+'.pdf'));}
   for(const b of project.boards){const board=`<!doctype html><html><head><style>@page{size:A4 landscape;margin:10mm}body{margin:0}</style><title>${esc(b.name)}</title></head><body>${boardSVG(b)}</body></html>`;const path=join(out,'boards',b.id+'.html');await writeFile(path,board);files['boards/'+b.id+'.html']=board;await page.goto(pathToFileURL(path).href);await page.pdf({path:join(out,'boards',b.id+'.pdf'),printBackground:true,preferCSSPageSize:true});files['boards/'+b.id+'.pdf']=await readFile(join(out,'boards',b.id+'.pdf'));}
  }finally{await browser.close();}
 }
 await writeFile(join(out,'game-kit.zip'),new Uint8Array(await zipFiles(files).arrayBuffer()));return{title:project.title,destination:out,files:Object.keys(files)};
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');console.log(JSON.stringify(await exportGame(root,process.argv[2]??join(root,'delivery'))));}
