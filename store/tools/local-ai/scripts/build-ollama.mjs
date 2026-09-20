// Package the shared sources so Store installs need only this harness directory.
import { cp, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, '../../agents/ollama');
await mkdir(join(target, 'toolchain'), { recursive: true });
for (const directory of ['src', 'bin', 'dist']) {
  await cp(join(root, directory), join(target, directory), { recursive: true });
}
await copyFile(join(root, 'toolchain/node.sh'), join(target, 'toolchain/node.sh'));
console.log('Built Ollama with the shared control plane and viewer.');
