#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolchainDir = resolve(dirname(fileURLToPath(import.meta.url)));
const packageDir = resolve(toolchainDir, '..');
const runtime = process.env.LOCAL_AI_RUNTIME || 'ollama';
const major = Number(process.versions.node.split('.')[0]);

if (major < 22) { console.error('miss Node.js 22 or newer — update Harness or install Node.js 22'); process.exit(1); }

const workspace = process.env.HARNESS_WORKSPACE || process.cwd();
process.env.HARNESS_WORKSPACE = workspace;

const runtimeDir = process.env.ADAPTER_RUNTIME_DIR || resolve(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.harness', 'runtime');
const managedNodeRecord = resolve(runtimeDir, 'current-node');

let nodePath = process.env.LOCAL_AI_NODE || process.execPath;
if (!nodePath || nodePath === process.execPath) {
  try {
    const output = spawnSync(process.platform === 'win32' ? 'where.exe node' : 'command -v node', { encoding: 'utf8' }).stdout;
    if (output) nodePath = output.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    nodePath = undefined;
  }
}
if (!nodePath && existsSync(managedNodeRecord)) {
  const candidate = spawnSync('cat', [managedNodeRecord], { encoding: 'utf8' }).stdout.trim();
  if (candidate) {
    const nodeBinary = resolve(resolve(candidate, '..'), 'node');
    if (existsSync(nodeBinary)) nodePath = nodeBinary;
  }
}
if (!nodePath) { console.error('miss Node.js 22 or newer — update Harness or install Node.js 22'); process.exit(1); }

const harnessPath = resolve(packageDir, 'bin', 'harness.mjs');
const result = spawnSync(nodePath, [harnessPath, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
