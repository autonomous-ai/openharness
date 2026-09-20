#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { buildBrand } from './build.mjs';
console.log(JSON.stringify(await buildBrand(fileURLToPath(new URL('..',import.meta.url)),{check:true})));
