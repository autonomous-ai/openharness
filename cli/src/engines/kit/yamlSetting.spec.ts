/**
 * One string setting of a YAML file an engine keeps, read from real files in a throwaway folder. A sandbox controls
 * such a file: whatever it puts there is read within the limit or not at all, and nothing is ever written.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readYamlSetting } from './yamlSetting.js'

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})

let dir: string, file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yaml-setting-')); file = join(dir, 'config.yaml') })
afterEach(() => { vi.mocked(open).mockReset(); rmSync(dir, { recursive: true, force: true }) })
const read = (text: string) => { writeFileSync(file, text); return readYamlSetting(file, 'display', 'interface', 1 << 20) }

it('reads one string setting as it is written', async () => {
  expect(await read('model: x\ndisplay:\n  interface: " TUI "\n  skin: dark\n')).toBe(' TUI ')
  expect(await read('display: {interface: cli}\n')).toBe('cli')
})

it('reads it as the engine\'s YAML reader does: an alias followed, a merge key applied, the last of two equal keys', async () => {
  expect(await read('base: &b {interface: tui}\ndisplay: *b\n')).toBe('tui')
  expect(await read('base: &b {interface: tui}\ndisplay:\n  <<: *b\n')).toBe('tui')
  expect(await read('display:\n  interface: cli\n  interface: tui\n')).toBe('tui')
})

it.each(['', 'model: x\n', 'display: tui\n', 'display:\n  interface: [tui]\n', 'display:\n  interface: 1\n', 'display:\n  interface: tui\n  bad: [\n', '- display\n'])(
  'reads nothing from %j', async (text) => { expect(await read(text)).toBeNull() })

it('reads nothing from a file that is missing, a folder or over its limit, and reads one at its limit', async () => {
  expect(await readYamlSetting(join(dir, 'none.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
  mkdirSync(join(dir, 'folder.yaml')); expect(await readYamlSetting(join(dir, 'folder.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
  writeFileSync(file, 'display:\n  interface: tui\n' + '#'.repeat(64)); expect(await readYamlSetting(file, 'display', 'interface', 64)).toBeNull()
  expect(await readYamlSetting(file, 'display', 'interface', statSync(file).size)).toBe('tui')
})

it('reads nothing from a file that grew past its limit while it was read', async () => {
  writeFileSync(file, 'display:\n  interface: tui\n')
  const realOpen = vi.mocked(open).getMockImplementation()!
  vi.mocked(open).mockImplementationOnce(async (path, flags) => {
    const handle = await realOpen(path, flags)
    const stat = handle.stat.bind(handle)
    handle.stat = (async () => { const info = await stat(); appendFileSync(file, '#'.repeat(64)); return info }) as typeof handle.stat
    return handle
  })
  expect(await readYamlSetting(file, 'display', 'interface', 64)).toBeNull()
})

it.skipIf(process.platform === 'win32')('reads nothing from a FIFO, and is not held up by one', async () => {
  execFileSync('mkfifo', [join(dir, 'fifo.yaml')])
  expect(await readYamlSetting(join(dir, 'fifo.yaml'), 'display', 'interface', 1 << 20)).toBeNull()
})

it('follows a symlink to a config, as the engine does', async () => {
  writeFileSync(join(dir, 'real.yaml'), 'display:\n  interface: tui\n'); symlinkSync(join(dir, 'real.yaml'), join(dir, 'link.yaml'))
  expect(await readYamlSetting(join(dir, 'link.yaml'), 'display', 'interface', 1 << 20)).toBe('tui')
})
