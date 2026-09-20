#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/node.sh
"$LOCAL_AI_NODE" --input-type=module <<'JS'
import { findOllama } from './src/ollama.mjs';
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error('miss Node.js 22 or newer'); process.exit(1); }
console.log(`ok   Node ${process.versions.node}`);
const binary = await findOllama();
if (!binary) { console.error('miss Ollama — install the official macOS app from https://ollama.com/download/mac'); process.exit(1); }
console.log(`ok   Ollama CLI (${binary})`);
console.log('ok   Local viewer and operator; no npm dependencies');
JS
