import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { alive } from '../../testing/spawnedRuns.js'
import { spawnTied } from './tied.js'

const windows = process.platform === 'win32'
const CLI = fileURLToPath(new URL('../../..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'tied-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const gone = (...pids: number[]) => vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 10_000, interval: 20 })
/** The group the command led is empty: it and its watcher have ended and been reaped (a zombie still counts). */
const groupGone = (pid: number) => vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/), { timeout: 10_000, interval: 20 })
const closed = (child: ChildProcess) => new Promise<[number | null, NodeJS.Signals | null]>(done => child.once('close', (code, signal) => done([code, signal])))
/** A tied Node child, ended by its handle when the test ends, so a failing case leaves nothing running. */
function node(script: string, options: Partial<Parameters<typeof spawnTied>[2]> = {}): ChildProcess {
  const child = spawnTied(process.execPath, ['-e', script], { env: process.env, ...options })
  onTestFinished(() => { child.kill('SIGKILL') })
  return child
}
const FOREVER = 'console.log(process.pid); setInterval(() => {}, 1 << 30)'
const ECHO = `process.stdin.on('data', d => process.stdout.write('out:' + d)); process.stdin.on('end', () => { process.stderr.write('err'); process.exitCode = 7 })`

// The agent browser's process, as far as this matters: it starts a long-lived command through spawnTied, says the
// pid it was handed and the pid the command printed, then dies when the spec says so.
const STAND_IN = join(scratch, 'stand-in.mts')
writeFileSync(STAND_IN, [
  `import { spawnTied } from ${JSON.stringify(new URL('./tied.ts', import.meta.url).href)}`,
  `const child = spawnTied(process.execPath, ['-e', ${JSON.stringify(FOREVER)}], { env: process.env, windowsHide: true })`,
  `child.stdout.once('data', (said) => console.log(JSON.stringify({ child: child.pid, said: Number(String(said)) })))`,
  `process.stdin.once('data', () => process.exit(0))`,
].join('\n'))

function firstLine(standIn: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let said = ''
    standIn.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      said += chunk
      if (said.includes('\n')) resolve(said.slice(0, said.indexOf('\n')))
    })
    standIn.once('exit', (code, signal) => reject(new Error(`the stand-in ended (${code ?? signal}) before it said its pids`)))
  })
}

function output(child: ChildProcess): { out: string; err: string } {
  const said = { out: '', err: '' }
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { said.out += chunk })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { said.err += chunk })
  return said
}

describe('spawnTied', () => {
  it.each([
    ['is killed', (standIn: ChildProcess) => { standIn.kill('SIGKILL') }], // TerminateProcess on Windows
    ['ends by itself', (standIn: ChildProcess) => { standIn.stdin!.write('go\n') }],
  ])('the command ends when the process that started it %s', async (_, end) => {
    const standIn = spawn(process.execPath, ['--import', 'tsx', STAND_IN], { cwd: CLI, stdio: ['pipe', 'pipe', 'inherit'] })
    let child: number | undefined
    onTestFinished(() => {
      standIn.kill('SIGKILL')
      if (child !== undefined) try { process.kill(child, 'SIGKILL') } catch { /* gone */ }
    })
    const pids = JSON.parse(await firstLine(standIn)) as { child: number; said: number }
    child = pids.child
    expect(pids.said).toBe(pids.child) // the child handed back is the command itself
    end(standIn)
    await gone(pids.child)
  })

  it('the command keeps its exit code, and its stdin, stdout and stderr', async () => {
    const child = node(ECHO)
    const said = output(child)
    child.stdin!.end('in')
    expect(await closed(child)).toEqual([7, null])
    expect(said).toEqual({ out: 'out:in', err: 'err' })
  })

  it.skipIf(windows)('a command that exits by itself leaves no watcher behind', async () => {
    const child = node('0', { detached: true })
    await closed(child)
    await groupGone(child.pid!)
  })

  it.skipIf(windows)('child.kill reaches the command itself', async () => {
    const heard = node(`process.on('SIGTERM', () => process.exit(3)); ${FOREVER}`)
    heard.stdout!.once('data', () => heard.kill())
    expect(await closed(heard)).toEqual([3, null])
    const killed = node(FOREVER)
    killed.stdout!.once('data', () => killed.kill('SIGKILL'))
    expect(await closed(killed)).toEqual([null, 'SIGKILL'])
  })

  it.skipIf(windows)('fd 3 closing, as the OS closes it when this process dies, ends the command with SIGTERM', async () => {
    const child = node(FOREVER, { detached: true })
    child.stdout!.once('data', () => child.stdio[3]!.destroy())
    expect(await closed(child)).toEqual([null, 'SIGTERM'])
    await groupGone(child.pid!)
  })

  it.skipIf(windows)('an error on fd 3, a watcher already gone, is not this process\'s', async () => {
    const child = node(FOREVER)
    expect(() => child.stdio[3]!.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    child.kill('SIGKILL')
    await closed(child)
  })

  it.skipIf(windows)('the file and every argument reach the command byte for byte, never read by the shell', async () => {
    const dir = join(scratch, 'a dir $x')
    mkdirSync(dir)
    const file = join(dir, 'print args')
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\000' "$@"\n`, { mode: 0o755 })
    const odd = ['a b', '', '$HOME', '`id`', '"double" \'single\'', '; echo x', 'line\nbreak', '-c', '*', '--label=harness.agent=ünï']
    const child = spawnTied(file, odd, { env: process.env })
    onTestFinished(() => { child.kill('SIGKILL') })
    const said = output(child)
    expect(await closed(child)).toEqual([0, null])
    expect(said.out.split('\0').slice(0, -1)).toEqual(odd)
  })

  it.skipIf(windows)('a command ended at once, before the shell has become it, still closes and leaves no watcher', async () => {
    const child = node(FOREVER, { detached: true })
    child.kill()
    expect((await closed(child))[1]).toBe('SIGTERM')
    await groupGone(child.pid!)
  })

  it('with Windows as its platform it is a plain spawn: three pipes, the command\'s own exit code', async () => {
    const child = node('process.exitCode = 5', { platform: 'win32', windowsHide: true })
    expect(child.stdio).toHaveLength(3)
    expect(await closed(child)).toEqual([5, null])
  })

  it('runs on the Windows runners, where the Windows half is proven', () => {
    expect(readFileSync(join(CLI, '..', '.github', 'workflows', 'windows.yml'), 'utf8')).toContain("'src/services/agentBrowser/tied.spec.ts'")
  })
})
