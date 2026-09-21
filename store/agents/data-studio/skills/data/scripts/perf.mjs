#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const candidates = [
  ...(process.env.HARNESS_VIEWER_DIR ? [pathToFileURL(resolve(process.env.HARNESS_VIEWER_DIR, 'probe.mjs'))] : []),
  new URL('../../../../isolated-web-viewer/probe.mjs', import.meta.url),
  new URL('../../../../../viewers/isolated-web-viewer/probe.mjs', import.meta.url)
];
const path = candidates.find(file => existsSync(file));
if (!path) {
  console.error('Install or update autonomous/isolated-web-viewer to run browser verification.');
  process.exitCode = 2;
} else {
  const { probe } = await import(path.href);
  await probe({ mode: 'perf' });
}
