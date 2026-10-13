#!/usr/bin/env node
import { findHarness, runHarness, serveSetup } from './index.mjs'

const harness = findHarness()
if (harness) process.exitCode = await runHarness(harness)
else await serveSetup()
