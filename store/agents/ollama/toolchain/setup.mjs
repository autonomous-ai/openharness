#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolchainDir = resolve(dirname(fileURLToPath(import.meta.url)));
const doctor = spawnSync(process.execPath, [join(toolchainDir, 'doctor.mjs')], { stdio: 'inherit' });
if (doctor.error) throw doctor.error;
if (doctor.status !== 0) process.exit(doctor.status ?? 1);
