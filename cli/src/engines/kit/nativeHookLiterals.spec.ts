/**
 * A person's path is literal data, including replacement-string and template syntax, and the log names it by its hash:
 * a path names the person's home, and Export logs sends the log off the machine.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { hashOf } from '../../lib/log.js'
import { installNativeHookSettings } from './nativeHookSettings.js'
import { installNativePlugin } from './nativePlugin.js'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks() })
const said = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')

it('a native settings install names its file by a hash, never its path', async () => {
  root = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const file = join(root, '$&-${credential}.json')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await installNativeHookSettings({ file, engine: 'copilot', schema: 'file', version: 1, eventFlag: '--copilot-event', events: ['sessionStart'],
    messages: { current: 'current', installed: 'installed {file}', failed: 'failed' } }, 19473)
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.sessionStart[0].command).toContain('--port 19473')
  expect(said(log)).not.toContain('sentinel')
  expect(log).toHaveBeenCalledWith(`installed ${hashOf(file)} (outside the home)`)
})
it('a native plugin install renders its argument contents once and names its file by a hash, never its path', async () => {
  root = mkdtempSync(join(tmpdir(), 'sentinel-'))
  const file = join(root, '$&-${version}.js')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await installNativePlugin({ file, template: ['credential=', { argument: 'credential' }, ';version=', { argument: 'version' }],
    messages: { current: 'current', installed: 'installed {file}', after: [], failed: 'failed' } },
  { credential: '${version}$&', version: 'fixture', port: '19473' })
  expect(readFileSync(file, 'utf8')).toBe('credential=${version}$&;version=fixture')
  expect(said(log)).not.toContain('sentinel')
  expect(log).toHaveBeenCalledWith(`installed ${hashOf(file)} (outside the home)`)
})
