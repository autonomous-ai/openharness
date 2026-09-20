import {readFile,writeFile,mkdir,mkdtemp,rename,rm,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {write,prepare} from './ooxml.mjs';
const ws=resolve(process.env.HARNESS_WORKSPACE||process.cwd()),meta=join(ws,'.harness');await mkdir(meta,{recursive:true});
const verdict=async(ready,summary,findings=[])=>writeFile(join(meta,'verdict.json'),JSON.stringify({spec:1,ready,summary,findings,artifact:ready?'out.pdf':null,updatedAt:new Date().toISOString()},null,2)+'\n');
await verdict(false,'Building editable documents and a fresh PDF…');let stage,log='';
try{
 const raw=await readFile(join(ws,'doc.json'),'utf8');if(raw.length>2*1024*1024)throw new Error('doc.json exceeds 2 MiB.');const source=JSON.parse(raw),model=prepare(source);
 stage=await mkdtemp(join(meta,'documents-'));const sizes=write(stage,source);
 let bin=process.env.SOFFICE_BIN;if(!bin){bin=spawnSync('/bin/sh',['-c','command -v soffice'],{encoding:'utf8'}).stdout.trim();if(!bin){const mac='/Applications/LibreOffice.app/Contents/MacOS/soffice';try{await access(mac);bin=mac;}catch{}}}
 if(!bin){for(const name of ['out.docx','out.xlsx'])await rename(join(stage,name),join(ws,name));throw new Error('DOCX and XLSX were built, but PDF preview is unavailable. Install LibreOffice or set SOFFICE_BIN. An old PDF is not a new preview.');}
 const pdfDir=join(stage,'pdf'),recalcDir=join(stage,'recalculated');await mkdir(pdfDir);await mkdir(recalcDir);
 const convert=(format,out,file)=>{const result=spawnSync(bin,['-env:UserInstallation='+pathToFileURL(join(stage,'profile')).href,'--headless','--convert-to',format,'--outdir',out,file],{cwd:stage,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});log+=(result.stdout||'')+(result.stderr||'');if(result.error||result.status!==0)throw new Error(result.error?.message||'LibreOffice conversion failed; inspect .harness/export.log.');};
 convert('pdf',pdfDir,join(stage,'out.docx'));const pdf=await readFile(join(pdfDir,'out.pdf'));if(pdf.length<100||pdf.subarray(0,5).toString()!=='%PDF-')throw new Error('LibreOffice produced no fresh PDF.');
 convert('xlsx',recalcDir,join(stage,'out.xlsx'));const xlsx=await readFile(join(recalcDir,'out.xlsx'));if(xlsx.length<500||xlsx.subarray(0,2).toString()!=='PK')throw new Error('LibreOffice produced no fresh recalculated workbook.');
 await rename(join(stage,'out.docx'),join(ws,'out.docx'));await rename(join(recalcDir,'out.xlsx'),join(ws,'out.xlsx'));await rename(join(pdfDir,'out.pdf'),join(ws,'out.pdf'));
 await writeFile(join(meta,'export.json'),JSON.stringify({source:'doc.json',summary:model.summary,rows:model.sheet.length-1,bytes:{docx:sizes.docx,xlsx:xlsx.length,pdf:pdf.length},verification:'Fresh DOCX-to-PDF conversion and XLSX re-save by LibreOffice; visual review still required.'},null,2)+'\n');
 await verdict(true,'Editable DOCX + recalculated XLSX + fresh PDF',[{severity:'info',kind:'review',message:'Review the generated pages and inputs. Conversion is not a factual or layout-quality certificate.'}]);console.log('ok   out.docx + out.xlsx + out.pdf');
}catch(error){await verdict(false,'Document export incomplete',[{severity:'error',kind:'export',message:error.message}]);console.error(error.message);process.exitCode=1;}
finally{await writeFile(join(meta,'export.log'),log);if(stage)await rm(stage,{recursive:true,force:true});}
