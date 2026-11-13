#!/usr/bin/env node
import { start } from '../src/server.mjs';

const server = await start();
server.on('error', error => { console.error(error.message); process.exit(1); });
