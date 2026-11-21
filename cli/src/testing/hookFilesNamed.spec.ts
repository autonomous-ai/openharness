import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hashOf } from '../lib/log.js'

const { hooksOutside } = await import('../../e2e/harness/daemon.js' as string) as { hooksOutside: (log: string, root: string) => string[] }

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hook-files-named-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A file under the root, as an install would have left it. */
const written = (...parts: string[]): string => {
  const file = join(root, ...parts)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{}\n')
  return file
}

it('hooksOutside finds a hook file outside the root by its hash', () => {
  const inside = written('home', '.claude', 'settings.json')
  const log = `[hooks] installed Claude Code session, turn, wait and subagent hooks → ${hashOf(inside)}\n`
    + `[hooks] installed Codex session and turn hooks → ${hashOf('/elsewhere/settings.json')}\n`
  expect(hooksOutside(log, root)).toEqual([hashOf('/elsewhere/settings.json')])
})

it('reads the three line shapes, the update line by the file after its script', () => {
  const log = `[hooks] installed Codex session and turn hooks → ${hashOf('/elsewhere/hooks.json')}\n`
    + `[hooks] Devin config file is invalid JSON; leaving it unchanged: ${hashOf('/elsewhere/config.json')}\n`
    + `[hooks] updated (path/port changed) → ${hashOf('/opt/harness/notify.mjs')} --port 19473 in ${hashOf('/elsewhere/settings.json')}\n`
  expect(hooksOutside(log, root)).toEqual([hashOf('/elsewhere/hooks.json'), hashOf('/elsewhere/config.json'), hashOf('/elsewhere/settings.json')])
})

it('reads only the hooks\' lines, and a file named by a name rather than a hash is no file of the log\'s', () => {
  const inside = written('home', '.codex', 'hooks.json')
  const log = `[hooks] Codex session and turn hooks already installed → ${hashOf(inside)}\n`
    + "[hooks] recorded Harness's own Codex hooks as reviewed → config.toml\n"
    + `[backend] connected → ${hashOf('/elsewhere/url')}\n`
  expect(hooksOutside(log, root)).toEqual([])
})
