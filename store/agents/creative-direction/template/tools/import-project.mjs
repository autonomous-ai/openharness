#!/usr/bin/env node
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../studio/project.mjs';
import { buildBrand } from './build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.argv[2])throw new Error('Usage: node tools/import-project.mjs saved.forme.json');
const bytes=await readFile(resolve(process.argv[2]),'utf8');if(bytes.length>36000000)throw new Error('Project exceeds 36 MB.');
const project=validateProject(JSON.parse(bytes));delete project.revision;
const backup=join(root,'.harness/history',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(backup,{recursive:true});await writeFile(join(backup,'project.json'),await readFile(join(root,'board/project.json')));
await writeFile(join(root,'board/project.json'),JSON.stringify(project,null,2)+'\n');
console.log(JSON.stringify({...await buildBrand(root),backup}));
