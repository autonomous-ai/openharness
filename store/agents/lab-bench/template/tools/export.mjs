#!/usr/bin/env node
import {mkdir, writeFile, readFile, realpath} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readProject, buildBench, toolsDirectory} from './build.mjs';
import {kitFiles, esc} from '../studio/formats.mjs';
import {zipFiles} from '../studio/archive.mjs';
export async function exportBench(workspace, destination, {project: provided, pdf = true} = {}) {
  const root = resolve(workspace), out = resolve(destination), project = provided ?? await readProject(root);
  const {html, assets} = await buildBench(root, {project}), files = kitFiles(project, html, assets); await mkdir(out, {recursive: true});
  for (const [name, body] of Object.entries(files)) {const path = join(out, name); await mkdir(dirname(path), {recursive: true}); await writeFile(path, body);}
  if (pdf) {
    const tools = await toolsDirectory(), {chromium} = await import(pathToFileURL(join(tools, 'node_modules/playwright-core/index.mjs')).href), {browserPath} = await import(pathToFileURL(join(tools, 'browser.mjs')).href);
    const browser = await chromium.launch({executablePath: await browserPath(), headless: true});
    try {const page = await browser.newPage(); for (const name of ['report', 'collection-sheet']) {await page.goto(pathToFileURL(join(out, name + '.html')).href); await page.pdf({path: join(out, name + '.pdf'), printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="width:100%;padding:0 15mm;font-family:Arial;font-size:8px;color:#526f67;display:flex;justify-content:space-between"><span>${esc(project.title)} · ${name === 'report' ? 'Experiment report' : 'Collection sheet'}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`}); files[name + '.pdf'] = await readFile(join(out, name + '.pdf'));}}
    finally {await browser.close();}
  }
  await writeFile(join(out, 'experiment-kit.zip'), new Uint8Array(await zipFiles(files).arrayBuffer()));
  return {title: project.title, destination: out, files: Object.keys(files)};
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); console.log(JSON.stringify(await exportBench(root, process.argv[2] ?? join(root, 'delivery'))));}
