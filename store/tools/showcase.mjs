#!/usr/bin/env node
// Render captions as a native Flutter layout, then encode a six-slide GIF.
// Prompts come verbatim from package metadata. Source screenshots stay untouched.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shots = JSON.parse(readFileSync(resolve(root, 'store/readme-showcase.json'), 'utf8'));
const frames = mkdtempSync(join(tmpdir(), 'harness-showcase-'));
const output = resolve(root, '.github/assets/store');
mkdirSync(output, {recursive: true});
const examples = shots.map(shot => {
  const path = `store/showcase/${shot.id}/${shot.image}`;
  const facts = JSON.parse(readFileSync(resolve(root, `store/agents/${shot.id}/store.json`), 'utf8'));
  if (facts.listed === false) throw Error(`Showcase includes an unlisted harness: ${shot.id}`);
  const manifest = JSON.parse(readFileSync(resolve(root, `store/agents/${shot.id}/harness.json`), 'utf8'));
  const example = facts.examples.find(e => e.image?.endsWith(`/${shot.id}/${shot.image}`));
  if (!example) throw Error(`No original prompt for ${path}`);
  // Keep the showcase moving; the README links still images and full prompts.
  const seconds = 3;
  return {...shot, name: manifest.name, path, prompt: example.prompt, seconds};
});
execFileSync(process.env.FLUTTER_BIN || 'flutter', ['test', '--no-pub', 'tool/render_readme_showcase.dart'], {
  cwd: resolve(root, 'desktop'), env: {...process.env, HARNESS_SHOWCASE_DIR: frames}, stdio: 'inherit',
});
const concat = examples.map((e,i) => `file '${join(frames, `frame-${i}.png`)}'\nduration ${e.seconds}`).join('\n');
writeFileSync(join(frames, 'slides.txt'), concat + '\n');
execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', [
  '-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',join(frames,'slides.txt'),
  '-filter_complex','split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a',
  '-fps_mode','vfr','-loop','0','-final_delay',String(examples.at(-1).seconds * 100),
  join(output,'showcase.gif'),
], {stdio:'inherit'});
copyFileSync(join(frames,'frame-0.png'), join(output,'showcase-poster.png'));
const gallery = [
  '<!-- store-showcase:start -->',
  '<p align="center">',
  '  <a href=".github/assets/store/showcase.gif"><img src=".github/assets/store/showcase.gif" width="1280" alt="Six real harness outputs, shown one at a time with their harness name and complete prompt: Autonomous Circuit, text-to-cad, MuJoCo, Blender, Godogen, and Manim."></a>',
  '</p>', '',
  'Six real outputs, one at a time. Each slide includes the harness and the original prompt.',
  '[Still preview](.github/assets/store/showcase-poster.png) · Individual images and prompts below.', '',
  '<details>', '<summary>Read the prompts and open individual images</summary>', '',
  ...examples.flatMap(e => [
    `**[${e.name}](${e.path})** · [Open harness](store/agents/${e.id}/)`, '',
    `> ${e.prompt}`, '',
  ]),
  '</details>',
  '<!-- store-showcase:end -->',
].join('\n');
let readme = readFileSync(resolve(root,'README.md'),'utf8');
const marked = /<!-- store-showcase:start -->[\s\S]*?<!-- store-showcase:end -->/;
if (marked.test(readme)) readme = readme.replace(marked,gallery);
else {
  const start = readme.indexOf('<table>');
  const end = readme.indexOf('</table>',start);
  if(start<0||end<0) throw Error('Cannot find the README showcase table');
  readme = readme.slice(0,start)+gallery+readme.slice(end+'</table>'.length);
}
writeFileSync(resolve(root,'README.md'),readme);
console.log(`Saved ${examples.length} slides, ${examples.reduce((n,e)=>n+e.seconds,0)} seconds per loop, ${(statSync(join(output,'showcase.gif')).size/1048576).toFixed(2)} MiB. Preview frames: ${frames}`);
