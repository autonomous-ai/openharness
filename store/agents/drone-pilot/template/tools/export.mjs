#!/usr/bin/env node
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProject,buildFlight} from './build.mjs';
import {planProject,ASSUMPTIONS} from '../studio/project.mjs';
import {geoJSON,photoCSV,routeCSV,flightCSV,kml,report,reportHTML,mapSVG,slug} from '../studio/formats.mjs';
import {zipFiles} from '../studio/archive.mjs';
export async function exportFlight(workspace,output=join(workspace,'delivery')){
  await buildFlight(workspace);const p=await readProject(workspace),plan=planProject(p),html=await readFile(join(workspace,'flight/index.html'),'utf8');
  const payload=JSON.parse(html.match(/<script id="vector-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const files=[[slug(p.title)+'.vector.json',JSON.stringify(p,null,2)],['planner.html',html],['survey.geojson',JSON.stringify(geoJSON(plan),null,2)],['overlay.kml',kml(plan)],['site-map.svg',mapSVG(plan)],['planned-photos.csv',photoCSV(plan)],['planned-route.csv',routeCSV(plan)],['report.json',JSON.stringify(report(plan),null,2)],['report.html',reportHTML(plan)],['LICENSES.txt',payload.licenses],['README.md',`# ${p.title}\n\n${p.brief}\n\nOpen planner.html to edit offline. Keep the .vector.json source. Load survey.geojson in GIS or overlay.kml in a map viewer; KML is ground-clamped. CSV coordinates are longitude/latitude degrees, with explicit height above takeoff and nominal timing. Files are for planning and review, not aircraft upload. Print report.html to PDF.\n\n${ASSUMPTIONS}\n\nOriginal recorded CSV, if supplied, is retained unchanged with SHA-256 and explicit column/unit mapping. Event footprints do not prove image existence or quality.\n`]];
  if(p.log)files.push(['recorded-source.csv',p.log.raw],['recorded-normalized.csv',flightCSV(plan)]);
  await mkdir(output,{recursive:true});for(const [name,body]of files)await writeFile(join(output,name),body);await writeFile(join(output,slug(p.title)+'-field-kit.zip'),new Uint8Array(await zipFiles(files).arrayBuffer()));
  return {title:p.title,output,files:files.map(([name])=>name),photos:plan.photos.length,sorties:plan.sorties.length,coverage:plan.coverage};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');console.log(JSON.stringify(await exportFlight(root,process.argv[2]?resolve(process.argv[2]):undefined)));}
