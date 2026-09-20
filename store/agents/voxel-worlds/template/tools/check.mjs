#!/usr/bin/env node
import {readProject} from './build.mjs';
import {compileWorld,navigationReport} from '../studio/project.mjs';
import {exportGLB,exportVOX,importVOX} from '../studio/formats.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),p=await readProject(root),world=compileWorld(p),glb=exportGLB(p),vox=importVOX(exportVOX(p));
if(vox.cells.some((n,i)=>n!==world.cells[i]))throw new Error('VOX round trip changed geometry.');
const report={title:p.title,objects:p.objects.length,voxels:world.count,glbBytes:glb.length,voxRoundTrip:true,navigation:navigationReport(p),limits:'Finite model checks. Inspect the actual studio and reopen exported geometry before marking ready.'};
await mkdir(join(root,'.harness'),{recursive:true});await writeFile(join(root,'.harness/world-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(report.navigation.issues.length)process.exitCode=1;
