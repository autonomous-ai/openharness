import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from './node_modules/esbuild/lib/main.js';
const root=new URL('.',import.meta.url),target=new URL('../template/studio/math-vendor.mjs',root);
const result=await build({entryPoints:[fileURLToPath(new URL('math-entry.mjs',root))],bundle:true,format:'esm',write:false,minify:true,target:'es2022',legalComments:'inline'});
const source='// Generated from pinned ml-matrix / jstat. Full notices: THIRD_PARTY_LICENSES.txt.\n'+result.outputFiles[0].text;
const names=['ml-matrix','jstat','is-any-array','ml-array-rescale','ml-array-min','ml-array-max'];let licenses='Numerical libraries bundled in Signal\n\n';
for(const name of names){const path=new URL('node_modules/'+name+'/',root),pkg=JSON.parse(await readFile(new URL('package.json',path),'utf8'));let license;for(const file of ['LICENSE','LICENSE.txt','LICENSE.md']){try{license=await readFile(new URL(file,path),'utf8');break;}catch{}}if(!license)throw new Error('Missing license: '+name);licenses+=name+' '+pkg.version+'\n'+license+'\n\n';}
const notice=new URL('../template/studio/THIRD_PARTY_LICENSES.txt',root);
licenses=licenses.trimEnd()+'\n';
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==source||await readFile(notice,'utf8')!==licenses)throw new Error('Numerical bundle or licenses are stale.');}else{await writeFile(target,source);await writeFile(notice,licenses);}
