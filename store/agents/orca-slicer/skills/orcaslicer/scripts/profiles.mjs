import {readFile} from 'node:fs/promises';import {resolve,dirname,basename} from 'node:path';
// Orca's CLI does not reliably flatten shipped profile inheritance. Resolve the
// explicit sibling chain ourselves; never silently substitute unrelated defaults.
export async function resolveProfile(file,chain=[]){
  const path=resolve(file);if(chain.includes(path)||chain.length>=20)throw new Error('Cyclic or overly deep profile inheritance.');
  const value=JSON.parse(await readFile(path,'utf8'));
  if(!value||Array.isArray(value)||typeof value!=='object'||typeof value.name!=='string')throw new Error('Invalid profile: '+basename(path));
  let parent={};
  if(value.inherits){
    if(typeof value.inherits!=='string'||basename(value.inherits)!==value.inherits||value.inherits.includes('\\'))throw new Error('Profile parent must be a sibling profile name.');
    const parentFile=resolve(dirname(path),value.inherits+'.json');
    try{parent=await resolveProfile(parentFile,[...chain,path]);}catch(error){throw new Error('Cannot resolve '+value.name+' parent '+value.inherits+': '+error.message);}
  }
  const merged={...parent,...value,instantiation:'true'};delete merged.inherits;return merged;
}
