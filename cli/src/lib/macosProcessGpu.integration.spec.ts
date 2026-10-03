import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createHarnessResourcesReader, parseResourceProcesses } from './harnessResources.js'

const exec = promisify(execFile)
const enabled = process.platform === 'darwin' && process.env.RUN_MACOS_GPU === '1'

it.skipIf(!enabled)('measures a real Metal harness while an idle harness stays at zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-metal-test-'))
  const children: ChildProcess[] = []
  const launch = async (file: string, args: string[]) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture startup timed out')), 15_000)
      const finish = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : resolve() }
      child.once('error', finish)
      child.once('exit', code => finish(new Error(`Fixture exited: ${code}`)))
      child.stdout!.once('data', () => finish())
    })
    return child.pid!
  }
  try {
    const binary = join(directory, 'metal-fixture')
    await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Metal',
      fileURLToPath(new URL('./__fixtures__/macos-gpu.m', import.meta.url)), '-o', binary], { timeout: 30_000 })
    const gpuPid = await launch(binary, [])
    const idlePid = await launch(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'])
    const { stdout } = await exec('ps', ['-p', `${gpuPid},${idlePid}`, '-o', 'pid=,ppid=,rss=,time=,lstart='], {
      env: { ...process.env, LC_ALL: 'C' },
    })
    const agents = parseResourceProcesses(stdout).map(row => ({ agentId: String(row.pid),
      processIdentity: { pid: row.pid, startMarker: row.start, executable: 'test fixture' } }))
    expect(agents).toHaveLength(2)
    const read = createHarnessResourcesReader(() => agents, undefined, async () => [])
    expect((await read()).agents.every(row => row.gpuPercent === null)).toBe(true)
    await delay(3000)
    const sample = await read()
    const gpu = sample.agents.find(row => row.agentId === String(gpuPid))!
    const idle = sample.agents.find(row => row.agentId === String(idlePid))!
    expect(gpu.gpuPercent).not.toBeNull()
    expect(gpu.gpuPercent!).toBeGreaterThan(0)
    expect(idle.gpuPercent).toBe(0)
    console.log(`Metal GPU ${gpu.gpuPercent}%; idle harness GPU ${idle.gpuPercent}%`)
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode != null || child.signalCode != null) { resolve(); return }
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
