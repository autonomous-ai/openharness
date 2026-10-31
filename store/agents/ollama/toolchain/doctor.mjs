import { findOllama } from '../src/ollama.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error('miss Node.js 22 or newer'); process.exit(1); }
console.log(`ok   Node ${process.versions.node}`);

try {
  const binary = await findOllama();
  if (!binary) {
    console.error('miss Ollama — install the official app from ollama.com');
    process.exit(1);
  }
  console.log(`ok   Ollama CLI (${binary})`);
} catch {
  console.error('miss Ollama — install the official app from ollama.com');
  process.exit(1);
}
console.log('ok   Local viewer and operator; no npm dependencies');
