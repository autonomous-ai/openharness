// Run from cli/: PROBE_SRC=$PWD/src node --import tsx ../docs/design/2026-11-15-core-plan/tools/probes-bench.mts
// Use the same Node/dependency versions for both source trees and a quiet machine. The 1 ms observer's CPU is included.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate as turn } from 'node:timers/promises'
if (process.platform === 'win32') throw new Error('This benchmark uses POSIX fixtures; test Windows with a native PTY build')
const root = mkdtempSync(join(tmpdir(), 'core-probes-bench-'))
process.env.HOME = root; process.env.USERPROFILE = root; process.env.NODE_ENV = 'test'
process.env.HARNESS_DATA_DIR = join(root, 'data'); process.env.ADAPTER_DATA_DIR = join(root, 'data')
const paths = Array.from({ length: 48 }, (_, i) => join(root, 'path'+i))
for (const path of paths) mkdirSync(path)
process.env.PATH = paths.join(delimiter)
for (const [i, name] of ['claude','codex','cursor-agent','opencode','pi','omp','hermes','command-code','devin','muse','amp','kilo','grok','agy','copilot','openclaw'].entries()) writeFileSync(join(paths[i], name),'#!/bin/sh\n', { mode: 0o700 })
const src = process.env.PROBE_SRC!
const mod = await import(pathToFileURL(join(src, 'lib/engineBin.ts')).href)
const launch = await import(pathToFileURL(join(src, 'lib/ptyHost/launch.ts')).href)
async function measure(name: string, n: number, run: () => unknown) {
 let maxHold = 0, last = performance.now(), ticks = 0
 const watch = () => { const now = performance.now(); maxHold = Math.max(maxHold, now-last); last = now; ticks++ }
 const interval = setInterval(watch, 1), cpu = process.cpuUsage(), start = performance.now()
 for (let i=0;i<n;i++) { await run(); await turn(); watch() }
 clearInterval(interval)
 const used = process.cpuUsage(cpu)
 console.log(JSON.stringify({ name, n, wallMs: performance.now()-start, cpuMs:(used.user+used.system)/1000, maxHoldMs:maxHold, ticks, rss:process.memoryUsage().rss }))
}
try {
 await measure('ownership-48-paths',100,()=> (mod.agentCommandOwnershipSnapshotAsync ?? mod.agentCommandOwnershipSnapshot)())
 const shell = join(root, 'shell')
 writeFileSync(shell,`#!${process.execPath}\nconst end=Date.now()+200;while(Date.now()<end){}; console.log('__HARNESS_ENGINE_PATH__=' + ${JSON.stringify(paths[0])});process.stdout.write('__HARNESS_ENV_BEGIN__PATH=' + ${JSON.stringify(paths[0])} + '\\0');`,{mode:0o700})
 process.env.SHELL=shell;process.env.NODE_ENV='production'
 await measure('cold-shell-200ms',1,()=> (mod.agentCommandOwnershipSnapshotAsync ?? mod.agentCommandOwnershipSnapshot)())
 let i=0
 await measure('pty-version-200ms',3,()=>{
  const binary=join(root,'pty'+i++)
  writeFileSync(binary,`#!${process.execPath}\nconst end=Date.now()+200;while(Date.now()<end){};console.log(JSON.stringify({version:'1.0.0',protocol:1,features:[]}))`,{mode:0o700})
  return launch.targetHost({env:{HARNESS_PTY_BIN:binary}, runtimeDir:root, besideDir:join(root,'empty')})
 })
} finally { rmSync(root,{recursive:true,force:true}) }
