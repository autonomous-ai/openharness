// Package the shared control plane and viewer with MLX-LM's own identity and measurements.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, '../../agents/mlx-lm');
for (const directory of ['src', 'bin', 'dist/assets', 'toolchain']) await mkdir(join(target, directory), { recursive: true });
for (const name of ['catalog', 'controller', 'intents', 'mlx', 'ollama', 'server', 'store', 'viewer-relay']) {
  await copyFile(join(root, `src/${name}.mjs`), join(target, `src/${name}.mjs`));
}
await copyFile(join(root, 'bin/harness.mjs'), join(target, 'bin/harness.mjs'));
await copyFile(join(root, 'toolchain/node.sh'), join(target, 'toolchain/node.sh'));
const brand = text => text.replaceAll('Ollama', 'MLX-LM').replaceAll('OLLAMA', 'MLX-LM').replaceAll('ollama-icon', 'mlx-icon');
let html = brand(await readFile(join(root, 'dist/index.html'), 'utf8'));
html = html.replaceAll('#101516', '#10151f')
  .replace('Your MLX-LM models.', 'Models. Made for this Mac.')
  .replace('MLX-LM runtime</h2>', 'MLX on Apple Silicon</h2>')
  .replace('Model allocation</span>', 'MLX allocation</span>')
  .replace('Select a model to inspect', 'One model in memory at a time')
  .replace('Run an MLX-LM model', 'Run an MLX model');
await writeFile(join(target, 'dist/index.html'), html);
let app = brand(await readFile(join(root, 'dist/app.js'), 'utf8'));
app = app.replace('Repeated prompts can use the prefix cache.', 'Each sample starts with a fresh prompt cache.')
  .replace('MLX-LM reports runtime allocation.', 'MLX reports active allocations for this workspace, excluding its reusable memory cache.')
  .replace('Context window</span>', 'Harness context budget</span>')
  .replace('Exact local MLX-LM model name and tag.', 'Exact Hugging Face MLX model ID, including its owner.')
  .replace('${escapeHTML(b.model)}</span><div class="bar-track">', '${escapeHTML(b.model.split("/").at(-1))}</span><div class="bar-track">');
await writeFile(join(target, 'dist/app.js'), app);
let css = brand(await readFile(join(root, 'dist/styles.css'), 'utf8'));
css = css.replaceAll('#101516', '#10151f').replaceAll('#171d1e', '#171e2a').replaceAll('#1d2526', '#202a38')
  .replaceAll('#303939', '#344154').replaceAll('#9ba9a7', '#a2aec0').replaceAll('#c5f87e', '#a9caff').replaceAll('#7ed8d1', '#8ae8d4');
css += '\n/* Hugging Face model names are longer than Ollama tags. */\n.model-node strong,.model-title strong,.chart-row>span:first-child,.activity-row strong{overflow-wrap:anywhere}.model-node{min-width:0}.chart-row>span:first-child{font-size:.72rem}.activity-row>div{min-width:0}.model-title strong{white-space:normal}.sample-record strong{overflow-wrap:anywhere}\n';
await writeFile(join(target, 'dist/styles.css'), css);
for (const name of ['mlx-icon.svg', 'mlx-icon.png', 'README.md']) await copyFile(join(target, 'assets', name), join(target, 'dist/assets', name));
console.log('Built MLX-LM from the shared queue, controls, measurements and viewer.');
