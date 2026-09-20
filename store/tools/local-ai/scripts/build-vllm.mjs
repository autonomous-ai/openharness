// Reuse the shared viewer and control plane; specialize the vLLM serving surface.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, '../../agents/vllm');
for (const directory of ['src', 'bin', 'dist/assets', 'toolchain']) await mkdir(join(target, directory), { recursive: true });
for (const name of ['catalog', 'controller', 'intents', 'mlx', 'ollama', 'server', 'store', 'viewer-relay', 'json-worker', 'vllm']) await copyFile(join(root, `src/${name}.mjs`), join(target, `src/${name}.mjs`));
await copyFile(join(root, 'bin/harness.mjs'), join(target, 'bin/harness.mjs'));
await copyFile(join(root, 'toolchain/node.sh'), join(target, 'toolchain/node.sh'));
const brand = text => text.replaceAll('Ollama', 'vLLM').replaceAll('OLLAMA', 'vLLM').replaceAll('ollama-icon.svg', 'vllm-icon.png').replaceAll('ollama-icon.png', 'vllm-icon.png');
let html = brand(await readFile(join(root, 'dist/index.html'), 'utf8'))
  .replace('image/svg+xml', 'image/png').replaceAll('#101516', '#10151d')
  .replace('vLLM / ON THIS MAC', 'vLLM / METAL ON THIS MAC').replace('Your vLLM models.', 'Models, ready to serve.')
  .replace('vLLM runtime</h2>', 'vLLM · Metal backend</h2>').replace('Model allocation</span>', 'Server RSS</span>')
  .replace('Last generation</span>', 'Last request</span>').replace('Select a model to inspect', 'One server · continuous batching')
  .replace('<section class="models-panel"', '<section class="serving-panel" aria-labelledby="serving-heading"><div class="panel-heading"><h2 id="serving-heading">Serving</h2><span class="secondary" id="serving-state">Idle</span></div><div id="serving-content"></div></section>\n      <section class="models-panel"')
  .replace('<section class="performance-panel"', '<section class="concurrency-panel" aria-labelledby="concurrency-heading"><div class="panel-heading"><h2 id="concurrency-heading">Concurrent performance</h2><span class="secondary">Throughput &amp; latency</span></div><div id="concurrency-content"></div></section>\n      <section class="performance-panel"')
  .replace('id="performance-heading">Performance', 'id="performance-heading">Single-request baseline');
await writeFile(join(target, 'dist/index.html'), html);
let app = brand(await readFile(join(root, 'dist/app.js'), 'utf8'))
  .replace("const gib = bytes => ((bytes || 0) / 1024 ** 3).toFixed(1);", "const gib = bytes => Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) : '—';")
  .replace('Generation speed</h3>', 'Request throughput</h3>').replace('Measured median generation speed', 'Measured median end-to-end request throughput')
  .replace('Speed measures inference, not answer quality.', 'Token throughput includes prompt processing and HTTP; it is not native decode speed or answer quality.')
  .replace('vLLM reports runtime allocation.', 'RSS sums this workspace’s server processes and may count shared pages more than once. It is not GPU allocation.')
  .replace('Runtime allocation</span>', 'Server process RSS</span>').replace('allocation: ${gib(b.residentBytes)}', 'server RSS: ${gib(b.residentBytes)}')
  .replace('Exact local vLLM model name and tag.', 'Exact Hugging Face text model ID, including its owner.')
  .replace('${escapeHTML(b.model)}</span><div class="bar-track">', '${escapeHTML(b.model.split("/").at(-1))}</span><div class="bar-track">')
  .replace("$('#export-benchmarks').hidden = benchmarks.length === 0;", "$('#export-benchmarks').hidden = !benchmarks.length && !state.loadTests?.length; renderServing(); renderLoadTests();")
  .replace("['deploy', 'chat', 'benchmark'].includes(job.type)", "['deploy', 'serve', 'chat', 'benchmark', 'load_test'].includes(job.type)")
  .replace('>Benchmark</button><button data-chat=', '>Benchmark</button><button data-action="load_test" data-target="${escapeHTML(id)}">Test 4 concurrent</button><button data-chat=')
  .replace('await refresh();\nconst events', `${await readFile(join(target, 'viewer-extra.js'), 'utf8')}\nawait refresh();\nconst events`);
await writeFile(join(target, 'dist/app.js'), app);
let css = brand(await readFile(join(root, 'dist/styles.css'), 'utf8'))
  .replaceAll('#101516', '#10151d').replaceAll('#171d1e', '#171e29').replaceAll('#1d2526', '#202a38')
  .replaceAll('#303939', '#344052').replaceAll('#9ba9a7', '#a2adbf').replaceAll('#c5f87e', '#ffc743').replaceAll('#7ed8d1', '#7bb1ff');
css += await readFile(join(target, 'viewer-extra.css'), 'utf8');
await writeFile(join(target, 'dist/styles.css'), css);
for (const name of ['vllm-icon.png', 'README.md']) await copyFile(join(target, 'assets', name), join(target, 'dist/assets', name));
console.log('Built vLLM: shared viewer, Metal serving telemetry and concurrent measurements.');
