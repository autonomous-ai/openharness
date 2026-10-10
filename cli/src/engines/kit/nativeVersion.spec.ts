import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { majorVersion, nativeVersionProbe } from './nativeVersion.js'

const roots: string[] = []
const rule = { output: /(\d+)\.\d+\.\d+/, args: ['--version'], timeoutMs: 2_000 }
function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'native-version-probe-')); roots.push(root)
  const file = join(root, 'engine')
  writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  return file
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('keeps core timers responsive while a native version command is running', async () => {
  const file = fixture("setTimeout(() => console.log('2.0.18'), 100)")
  let responsive = false
  const timer = setTimeout(() => { responsive = true }, 20)
  try {
    expect(await majorVersion(rule, nativeVersionProbe(rule, () => file), new Map())).toBe(2)
    expect(responsive).toBe(true)
  } finally { clearTimeout(timer) }
})

it('reads the executable selected for this probe once instead of resolving a different command for execution', async () => {
  const first = fixture("console.log('1.18.31')"), second = fixture("console.log('2.0.18')")
  let calls = 0
  expect(await majorVersion(rule, nativeVersionProbe(rule, () => ++calls === 1 ? first : second), new Map())).toBe(1)
  expect(calls).toBe(1)
})

it('discards a version answer if the selected executable is replaced while it runs', async () => {
  const file = fixture("setTimeout(() => console.log('1.18.31'), 100)")
  const replacement = `${file}.new`
  writeFileSync(replacement, `#!${process.execPath}\nconsole.log('2.0.18')\n`, { mode: 0o700 })
  const memo = new Map<string, number | null>()
  const timer = setTimeout(() => renameSync(replacement, file), 30)
  try {
    expect(await majorVersion(rule, nativeVersionProbe(rule, () => file), memo)).toBeNull()
    expect(memo.size).toBe(0)
  } finally { clearTimeout(timer) }
})

it('bounds a native process that never answers', async () => {
  const file = fixture('setInterval(() => {}, 1000)')
  const bounded = { ...rule, timeoutMs: 80 }
  expect(await majorVersion(bounded, nativeVersionProbe(bounded, () => file), new Map())).toBeNull()
}, 2_000)

it('contains an output flood without blocking other callbacks', async () => {
  const file = fixture("process.stdout.write('1.18.31\\n' + 'x'.repeat(128 * 1024))")
  expect(await majorVersion(rule, nativeVersionProbe(rule, () => file), new Map())).toBeNull()
})

it('closes stdin for native launchers that read to EOF before reporting their version', async () => {
  const file = fixture("require('node:fs').readFileSync(0); console.log('2.0.18')")
  expect(await majorVersion(rule, nativeVersionProbe(rule, () => file), new Map())).toBe(2)
})

it('does not let an older failed probe replace a newer confirmed answer', async () => {
  const memo = new Map<string, number | null>()
  let fail!: (error: Error) => void
  const old = majorVersion(rule, { identity: () => 'same-file', read: () => new Promise<string>((_done, reject) => { fail = reject }) }, memo)
  expect(await majorVersion(rule, { identity: () => 'same-file', read: () => '2.0.18' }, memo)).toBe(2)
  fail(new Error('older timeout'))
  await old
  expect(memo.get('same-file')).toBe(2)
})

it('returns a confirmed answer while a newer probe of the unchanged file is still pending', async () => {
  const memo = new Map<string, number | null>()
  let first!: (output: string) => void, second!: (output: string) => void
  const older = majorVersion(rule, { identity: () => 'same-file', read: () => new Promise<string>(done => { first = done }) }, memo)
  const newer = majorVersion(rule, { identity: () => 'same-file', read: () => new Promise<string>(done => { second = done }) }, memo)
  try {
    first('2.0.18')
    expect(await older).toBe(2)
  } finally { second('2.0.18'); await newer }
  expect(memo.get('same-file')).toBe(2)
})

it('keeps the production resolver asynchronous when only the interactive shell can find OpenCode', async () => {
  const file = fixture("console.log('2.0.18')")
  const root = roots.at(-1)!, engine = join(root, 'opencode'), shell = join(root, 'shell'), release = join(root, 'allow-shell')
  renameSync(file, engine)
  writeFileSync(shell, `#!${process.execPath}\nconst fs = require('node:fs');\nconst timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('__HARNESS_ENGINE_PATH__=' + ${JSON.stringify(root)}); } }, 10)\n`, { mode: 0o700 })
  vi.stubEnv('HOME', root); vi.stubEnv('PATH', join(root, 'empty-path'))
  vi.stubEnv('SHELL', shell); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('OPENCODE_PATH', '')
  vi.resetModules()
  const { opencodeMajorVersion } = await import('../launchControl.js')
  const timer = setTimeout(() => writeFileSync(release, ''), 20)
  try { expect(await opencodeMajorVersion()).toBe(2) }
  finally { clearTimeout(timer) }
}, 8_000)
