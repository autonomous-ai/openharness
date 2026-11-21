import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

type Reader = { entries(dir: string): Pick<Dirent, 'name' | 'isFile' | 'isDirectory'>[]; text(file: string): string | null }
const { hooksOutside } = await import('../../e2e/harness/daemon.js' as string) as { hooksOutside: (log: string, root: string, read?: Reader) => string[] }

let root = '', elsewhere = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hook-files-named-')); elsewhere = mkdtempSync(join(tmpdir(), 'hook-files-elsewhere-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }) })

/** What an install leaves in a settings file: notify.mjs's command. */
const HOOKS = `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node '/opt/harness/notify.mjs' --port 19473"}]}]}}\n`
/** A file under [base], holding [text]. */
const written = (base: string, path: string, text = HOOKS): string => {
  const file = join(base, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  return file
}
/** The line each core starts with; what follows is that core's, its tags made with a key of its own (lib/log.ts hashOf). */
const core = (pid: number) => `2026-11-21 12:01:17.686 [cli] daemon pid ${pid} · v0.0.1 · listening on 127.0.0.1:19473`
const CLAUDE = (tag: string) => `2026-11-21 12:01:17.786 [hooks] installed Claude Code session, turn, wait and subagent hooks → ${tag}`
const CODEX = (tag: string) => `2026-11-21 12:01:17.785 [hooks] installed Codex session and turn hooks → ${tag}`

it('a core that names more files holding its hooks than the root holds has put one outside, and its lines are said', () => {
  written(root, 'home/.claude/settings.json')
  const log = [core(1), CLAUDE('93658264'), CODEX('b7d6b309'), '2026-11-21 12:01:17.810 [cli] ready'].join('\n')
  expect(hooksOutside(log, root)).toEqual([CLAUDE('93658264'), CODEX('b7d6b309')])
  written(root, 'codex/hooks.json')
  expect(hooksOutside(log, root)).toEqual([])
})

it('counts core by core: two cores name the same file by tags of their own', () => {
  written(root, 'codex/hooks.json')
  const log = [core(1), CODEX('cb680963'), core(2), CODEX('2f372bad').replace('installed Codex session and turn hooks', 'Codex session and turn hooks already installed')].join('\n')
  expect(hooksOutside(log, root)).toEqual([])
})

it('reads the three line shapes, the update line by the file after its script', () => {
  const update = '2026-11-21 12:01:18.000 [hooks] updated (path/port changed) → 0a1b2c3d --port 19473 in 9f8e7d6c'
  const current = '2026-11-21 12:01:18.001 [hooks] Codex session and turn hooks already installed → 4d5e6f70'
  const log = [core(1), CLAUDE('93658264'), current, update].join('\n')
  written(root, 'home/.claude/settings.json'); written(root, 'codex/hooks.json')
  expect(hooksOutside(log, root)).toEqual([CLAUDE('93658264'), current, update])
  written(root, 'work/.claude/settings.json')
  expect(hooksOutside(log, root)).toEqual([])
})

it('a removal, a file left as it was and another log\'s arrows name no file holding hooks', () => {
  const log = [core(1),
    "2026-11-21 12:01:18.000 [hooks] removed Harness's Hermes hooks → 1a2b3c4d",
    '2026-11-21 12:01:18.001 [hooks] Codex hooks file is invalid JSON; leaving it unchanged: 5e6f7a8b',
    "2026-11-21 12:01:18.002 [hooks] recorded Harness's own Codex hooks as reviewed → config.toml",
    '2026-11-21 12:01:18.003 [backend] connected → 9c0d1e2f'].join('\n')
  expect(hooksOutside(log, root)).toEqual([])
})

it('a hook line that names a path rather than a tag fails, whatever the root holds', () => {
  written(root, 'home/.codex/hooks.json'); written(root, 'home/.claude/settings.json')
  const named = `2026-11-21 12:01:18.000 [hooks] installed Codex session and turn hooks → ${join(root, 'home/.codex/hooks.json')}`
  const unchanged = '2026-11-21 12:01:18.001 [hooks] Devin config file is invalid JSON; leaving it unchanged: /elsewhere/config.json'
  expect(hooksOutside([core(1), named, unchanged].join('\n'), root)).toEqual([named, unchanged])
})

it('a plugin of Harness\'s holds its hooks, and a bundle that only quotes a plugin\'s first line holds none', () => {
  const plugin = '2026-11-21 12:01:18.000 [hooks] installed Kilo discovery plugin → 6d7e8f90'
  const log = [core(1), CLAUDE('93658264'), plugin].join('\n')
  written(root, 'home/.claude/settings.json')
  written(root, 'data/lean/chunk-KTXSH6UB.mjs', 'var KILO = ["// session-register — auto-installed by the machine adapter. Binds this ", "Kilo"]\n')
  expect(hooksOutside(log, root)).toEqual([CLAUDE('93658264'), plugin])
  written(root, 'home/.config/kilo/plugin/launcher-register.js', '// session-register — auto-installed by the machine adapter. Binds this Kilo session\n')
  expect(hooksOutside(log, root)).toEqual([])
})

it('a hook file reached through a link is not one the root holds', () => {
  symlinkSync(written(elsewhere, 'settings.json'), join(root, 'settings.json'))
  expect(hooksOutside([core(1), CLAUDE('93658264')].join('\n'), root)).toEqual([CLAUDE('93658264')])
})

it('a file over the most an installer reads is not read', () => {
  written(root, 'big.json', HOOKS + ' '.repeat(1024 * 1024))
  expect(hooksOutside([core(1), CLAUDE('93658264')].join('\n'), root)).toEqual([CLAUDE('93658264')])
})

// A daemon still running moves its files about: a folder or a file listed a moment ago can be gone when it is read.
it('passes over a folder or a file gone by the time it is read, and throws any other failure', () => {
  const gone = (code: string) => Object.assign(new Error(code), { code })
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' })
  const reader = (failure: string): Reader => ({
    entries: (dir) => {
      if (dir === root) return [entry('vanished', 'dir'), entry('replaced', 'dir'), entry('moved.json', 'file'), entry('settings.json', 'file')]
      if (dir === join(root, 'vanished')) throw gone('ENOENT')
      throw gone(failure)
    },
    text: (file) => {
      if (file === join(root, 'moved.json')) throw gone('ENOENT')
      return HOOKS
    },
  })
  const log = [core(1), CLAUDE('93658264')].join('\n')
  expect(hooksOutside(log, root, reader('ENOTDIR'))).toEqual([])
  expect(() => hooksOutside(log, root, reader('EACCES'))).toThrow('EACCES')
})
