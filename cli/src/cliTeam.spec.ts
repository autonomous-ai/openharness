import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))
const LOADER = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

// The Team installer and `harness team` are gone (anh Dee, 2026-11-10: "REMOVE IT"): an old Team account's daemon stops itself
// at each boot (superTabs/inCore/teamRetire.ts), and nothing makes, changes or lists one. The usage names no such command.
it.each(['status', 'on', 'off', 'remove', 'logs', 'ps'])('has no `harness team %s`: it is an unknown command, and touches nothing', (sub) => {
  const home = mkdtempSync(join(tmpdir(), 'cli-team-')); homes.push(home)
  const env = Object.fromEntries(['TEMP', 'TMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const run = spawnSync(process.execPath, ['--import', LOADER, CLI, 'team', sub], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...env, PATH: process.env.PATH, HOME: home, USERPROFILE: home, ADAPTER_DATA_DIR: join(home, 'data'), ADAPTER_UPDATE_DISABLE: '1' },
  })
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('Unknown command: team')
  expect(`${run.stdout}${run.stderr}`).not.toMatch(/harness team|Team account/)
  expect(readdirSync(home).filter(name => name !== 'data')).toEqual([])
}, 90_000)
