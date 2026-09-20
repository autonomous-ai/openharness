#!/usr/bin/env node
// Create an isolated acceptance workspace. Never overwrite an existing directory.
import { cp,mkdir,access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join,resolve } from 'node:path';
import { buildBrand } from '../template/tools/build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),[name,destination]=process.argv.slice(2);
if(!['morrow','vectorial','stillwater'].includes(name)||!destination)throw new Error('Usage: node examples/materialize.mjs morrow|vectorial|stillwater NEW_DIRECTORY');
const out=resolve(destination);let exists=false;try{await access(out);exists=true;}catch{}if(exists)throw new Error('Choose a new directory; existing workspaces are preserved.');
await cp(join(root,'template'),out,{recursive:true,filter:path=>!path.includes('/.harness')&&!path.includes('/delivery')});
if(name!=='morrow'){
  await cp(join(root,'examples',name,'project.json'),join(out,'board/project.json'));
  await cp(join(root,'examples',name,'site.html'),join(out,'board/site.html'));
  const assets=join(root,'examples',name,'assets');
  try{await access(assets);await cp(assets,join(out,'board/assets'),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
}
console.log(JSON.stringify({workspace:out,...await buildBrand(out)}));
