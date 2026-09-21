#!/usr/bin/env node
import {readFile, writeFile, mkdir, realpath, access} from 'node:fs/promises';
import {resolve, join, dirname, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {validateProject, digest} from '../studio/project.mjs';
import {verifySources} from '../studio/measurements.mjs';
export async function readProject(workspace) {
  const root = await realpath(workspace), path = await realpath(join(root, 'bench/project.json'));
  if (!path.startsWith(join(root, 'bench') + sep)) throw new Error('Keep source inside bench/.');
  return verifySources(JSON.parse(await readFile(path, 'utf8')));
}
export async function toolsDirectory() {
  for (const path of [process.env.LAB_DSH_DIR && join(process.env.LAB_DSH_DIR, 'toolchain'), fileURLToPath(new URL('../../toolchain/', import.meta.url))].filter(Boolean)) {
    try {await access(join(path, 'node_modules/esbuild/lib/main.js')); return path;} catch {}
  }
  throw new Error('Run Lab Bench setup. Set LAB_DSH_DIR when building an installed workspace.');
}
export async function buildBench(workspace, {check = false, project: provided} = {}) {
  const root = resolve(workspace), project = provided ? await verifySources(provided) : await readProject(root);
  project.revision = await digest(project);
  const tools = await toolsDirectory(), {build} = await import(pathToFileURL(join(tools, 'node_modules/esbuild/lib/main.js')).href);
  const app = await build({entryPoints: [join(root, 'studio/app.js')], bundle: true, write: false, format: 'iife', minify: true, target: 'es2022', legalComments: 'inline'});
  const read = name => readFile(join(root, 'studio', name), 'utf8');
  const [shell, css, icon, reproduce, requirements, licenses] = await Promise.all(['shell.html', 'style.css', 'icon.svg', 'reproduce.py', 'requirements.txt', 'THIRD_PARTY_LICENSES.txt'].map(read));
  const license = await readFile(join(tools, '../LICENSE'), 'utf8');
  const assets = {reproduce, requirements, licenses, license};
  const html = shell.replace('/* STUDIO_CSS */', () => css).replace('<!-- SIGNAL_ICON -->', () => icon)
    .replace('<!-- FAVICON -->', () => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">`)
    .replace('SIGNAL_DATA', () => JSON.stringify({project, assets}).replace(/</g, '\\u003c'))
    .replace('/* SIGNAL_APP */', () => app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
  if (provided) return {html, project, assets};
  const target = join(root, 'bench/index.html');
  if (check) {if (await readFile(target, 'utf8') !== html) throw new Error('Lab studio is stale. Run node tools/build.mjs.');}
  else {await writeFile(target, html); await mkdir(join(root, '.harness'), {recursive: true}); await writeFile(join(root, '.harness/verdict.json'), JSON.stringify({spec: 1, ready: false, artifact: 'bench/index.html', summary: project.title + ' built; measurement, model and report review pending'}) + '\n');}
  return {title: project.title, revision: project.revision};
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildBench(resolve(dirname(fileURLToPath(import.meta.url)), '..'), {check: process.argv.includes('--check')})));
