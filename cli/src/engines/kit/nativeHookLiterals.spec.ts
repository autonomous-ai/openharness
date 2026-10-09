/** A person's path is literal data, including replacement-string and template syntax. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { installNativeHookSettings } from './nativeHookSettings.js'
import { installNativePlugin } from './nativePlugin.js'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; vi.restoreAllMocks() })
it('reports a JSON settings destination verbatim', () => {
  root = mkdtempSync(join(tmpdir(), 'native-hook-literals-'))
  const file = join(root, '$&-${credential}.json')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  installNativeHookSettings({ file, engine: 'copilot', schema: 'file', version: 1, eventFlag: '--copilot-event', events: ['sessionStart'],
    messages: { current: 'current', installed: 'installed {file}', failed: 'failed' } }, 19473)
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.sessionStart[0].command).toContain('--port 19473')
  expect(log).toHaveBeenCalledWith(`installed ${file}`)
})
it('renders plugin argument contents once and reports its destination verbatim', () => {
  root = mkdtempSync(join(tmpdir(), 'native-hook-literals-'))
  const file = join(root, '$&-${version}.js')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  installNativePlugin({ file, template: ['credential=', { argument: 'credential' }, ';version=', { argument: 'version' }],
    messages: { current: 'current', installed: 'installed {file}', after: [], failed: 'failed' } },
  { credential: '${version}$&', version: 'fixture', port: '19473' })
  expect(readFileSync(file, 'utf8')).toBe('credential=${version}$&;version=fixture')
  expect(log).toHaveBeenCalledWith(`installed ${file}`)
})
