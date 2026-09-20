#!/usr/bin/env node
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildBrand } from './build.mjs';
import { filename } from '../studio/project.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=resolve(root,arg('--out','delivery')),scale=Number(arg('--scale','2'));
if(![1,2].includes(scale))throw new Error('Export scale must be 1 or 2.');
await buildBrand(root);
const tools=process.env.FORME_DSH_DIR?pathToFileURL(join(process.env.FORME_DSH_DIR,'toolchain/')).href:new URL('../../toolchain/',import.meta.url).href;
let chromium;try{({chromium}=await import(process.env.PLAYWRIGHT_MODULE||new URL('node_modules/playwright-core/index.mjs',tools).href));}catch{throw new Error('Run Creative Direction setup before exporting.');}
const executablePath=process.env.BROWSER_EXECUTABLE||await(await import(new URL('browser.mjs',tools).href)).browserPath();
const browser=await chromium.launch({executablePath,headless:true});
try{
  await mkdir(out,{recursive:true});const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(join(root,'board/index.html')).href);await page.locator('body[data-ready=true]').waitFor({timeout:20000});
  if(arg('--direction',null))await page.evaluate(id=>forme.chooseDirection(id),arg('--direction',null));
  const project=await page.evaluate(()=>forme.getProject()),d=project.directions.find(d=>d.id===project.active),reports=[];
  for(const b of d.boards){
    const result=await page.evaluate(({id,scale})=>forme.deliver(id,scale),{id:b.id,scale});
    if(result.warnings.length)throw new Error(result.warnings.map(w=>w.message).join('\n'));
    const stem=filename(b.id),png=Buffer.from(result.png.split(',')[1],'base64');
    if(png.readUInt32BE(16)!==b.width*scale||png.readUInt32BE(20)!==b.height*scale)throw new Error('Raster dimensions do not match.');
    await writeFile(join(out,stem+'.svg'),result.svg);await writeFile(join(out,stem+'.png'),png);
    const pdfPage=await browser.newPage(),mm=b.printMm??[b.width/96*25.4,b.height/96*25.4];
    await pdfPage.setContent(`<html><style>@page{size:${mm[0]}mm ${mm[1]}mm;margin:0}html,body{margin:0;width:${mm[0]}mm;height:${mm[1]}mm;overflow:hidden}body>svg{display:block;position:absolute;inset:0;width:100%;height:100%}</style>${result.svg}</html>`);
    await pdfPage.evaluate(()=>document.fonts.ready);await pdfPage.pdf({path:join(out,stem+'.pdf'),width:mm[0]+'mm',height:mm[1]+'mm',printBackground:true,preferCSSPageSize:true});await pdfPage.close();
    reports.push({id:b.id,pixels:[b.width*scale,b.height*scale],printMm:mm,sha256:createHash('sha256').update(result.svg).digest('hex'),warnings:result.warnings});
  }
  const files=await page.evaluate(()=>forme.textFiles());
  for(const [name,body]of files){await mkdir(dirname(resolve(out,name)),{recursive:true});await writeFile(join(out,name),body);}
  for(const [name,svg]of files.filter(([name])=>name.startsWith('logos/')&&name.endsWith('.svg'))){const png=await page.evaluate(svg=>forme.rasterize(svg),svg);await writeFile(join(out,name.replace(/\.svg$/,'.png')),Buffer.from(png.split(',')[1],'base64'));}
  if(project.assets.length)await mkdir(join(out,'source-assets'),{recursive:true});
  for(const a of project.assets){const ext={'image/svg+xml':'svg','image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[a.data.slice(5,a.data.indexOf(';'))];await writeFile(join(out,'source-assets',filename(a.id)+'.'+ext),Buffer.from(a.data.split(',')[1],'base64'));}
  for(const f of project.fonts){const ext=f.data.match(/^data:font\/([^;]+)/)[1];await writeFile(join(out,'fonts',filename(f.family)+'.'+ext),Buffer.from(f.data.split(',')[1],'base64'));}
  const guide=await browser.newPage();await guide.goto(pathToFileURL(join(out,'brand-guide.html')).href);await guide.evaluate(()=>document.fonts.ready);await guide.pdf({path:join(out,'brand-guide.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true});await guide.close();
  await page.screenshot({path:join(out,'studio.png'),fullPage:true});if(errors.length)throw new Error(errors.join('\n'));
  const report={title:project.title,direction:d.name,ready:false,boards:reports,limitations:['Visual and brief review required.','RGB output; confirm bleed and production requirements with the printer.','Static website with contact link, without commerce or signup backend.']};
  await writeFile(join(out,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output:out,boards:reports.length,pdf:true,ready:false}));
}finally{await browser.close();}
