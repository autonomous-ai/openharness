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

/** `harness team <args>` in a throwaway home: what it printed, how it ended, and what it left in the home. */
function team(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'cli-team-')); homes.push(home)
  const env = Object.fromEntries(['TEMP', 'TMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const run = spawnSync(process.execPath, ['--import', LOADER, CLI, 'team', ...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...env, PATH: process.env.PATH, HOME: home, USERPROFILE: home, ADAPTER_DATA_DIR: join(home, 'data'), ADAPTER_UPDATE_DISABLE: '1' },
  })
  return { status: run.status, out: `${run.stdout}${run.stderr}`, stderr: run.stderr, left: readdirSync(home).filter(name => name !== 'data') }
}

// The Team installer and `harness team` are gone (anh Dee, 2026-11-10: "REMOVE IT"). Nothing makes, changes or lists a Team
// account; the usage names no such command. (status, on, off, remove, logs and ps all took this one branch.)
it('has no `harness team`: it is an unknown command, and touches nothing', () => {
  const run = team('status')
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('Unknown command: team')
  expect(run.out).not.toMatch(/harness team|Team account/)
  expect(run.left).toEqual([])
}, 90_000)

// An old Team account's boot job runs `team __start <file>` before its daemon, which then stops itself
// (superTabs/inCore/teamRetire.ts): it answers quietly, so the daemon still starts and its log gets no usage text.
it('answers an old Team account\'s boot job quietly, exit 0, so its daemon still starts', () => {
  const run = team('__start', '/Library/Application Support/Harness/Team/handoff')
  expect({ status: run.status, out: run.out, left: run.left }).toEqual({ status: 0, out: '', left: [] })
}, 90_000)
