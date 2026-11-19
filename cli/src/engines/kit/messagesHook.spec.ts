import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { isMessagesBlock, isMessagesCommand, messagesCommand, MESSAGES_HOOK_SOURCE } from './messagesHook.js'

// How the watched path is changed: opened for writing in place, or a file renamed onto it.
const disk = vi.hoisted(() => ({ watch: '', changes: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const writes = (flags: unknown) => typeof flags === 'number' ? (flags & 3) !== 0 : typeof flags === 'string' && flags !== 'r'
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === disk.watch && writes(args[1])) disk.changes.push('write')
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === disk.watch) disk.changes.push('write')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === disk.watch) disk.changes.push('rename')
      return actual.renameSync(...args)
    },
  }
})
const writeMessagesHook = (root: string) => {
  const file = join(root, 'hook.mjs')
  return runHookPreparation([file], attempt => inspectHookFile(file, 0o700).replace(MESSAGES_HOOK_SOURCE, attempt))
}
const roots: string[] = []
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'messages-hook-'))); roots.push(root); return root }
afterEach(() => {
  disk.watch = ''
  disk.changes = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('the save goes through a temporary file renamed onto the target, and the script stays 0700', async () => {
  const root = scratch()
  disk.watch = join(root, 'hook.mjs')
  await writeMessagesHook(root)
  expect(disk.changes).toEqual(['rename'])
  expect(readFileSync(disk.watch, 'utf8')).toBe(MESSAGES_HOOK_SOURCE)
  if (process.platform !== 'win32') expect(statSync(disk.watch).mode & 0o777).toBe(0o700)
})

it('a file at the old temporary name is left alone', async () => {
  const root = scratch()
  const planted = join(root, `hook.mjs.${process.pid}.tmp`)
  writeFileSync(planted, 'planted')
  await writeMessagesHook(root)
  expect(readFileSync(planted, 'utf8')).toBe('planted')
  expect(readFileSync(join(root, 'hook.mjs'), 'utf8')).toBe(MESSAGES_HOOK_SOURCE)
})

it.each(['/fixture/messages', "/fixture/space and ' quote"])('recognizes the complete literal Messages protocol at %s', root => {
  const command = messagesCommand(root, '/fixture/runtime/node')
  expect(isMessagesCommand(command)).toBe(true)
  expect(isMessagesBlock({ hooks: [{ type: 'command', command }] })).toBe(true)
  expect(isMessagesBlock({ hooks: [{ type: 'prompt', command }] })).toBe(false)
  expect(isMessagesCommand(command + '; echo foreign')).toBe(false)
  expect(isMessagesCommand(command.replace('--root', '--unrelated'))).toBe(false)
})

it('never infers ownership from a marker, basename, unrelated script or shell expansion', () => {
  const command = messagesCommand('/fixture/messages', '/fixture/runtime/node')
  for (const value of [null, '', 'echo harness-agent-messages', command.replace('/hook.mjs', '/foreign.mjs'),
    command.replace('/fixture/runtime/node', '/fixture/runtime/foreign'), command.replace("'/fixture/runtime/node'", '$(find-node)'),
    messagesCommand('relative', '/fixture/runtime/node'), command + '\0', 'x'.repeat(65537)]) {
    expect(isMessagesCommand(value), String(value).slice(0, 120)).toBe(false)
  }
})
