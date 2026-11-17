import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareNativeTrust } from './nativeSetupTrust.js'
import { boundedTrustInput, type NativeTrustInput } from '../engines/kit/nativeTrustWire.js'
import * as nativeFiles from '../engines/kit/nativeHookFiles.js'

let root: string, cwd: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'trust-worker-')); cwd = join(root, 'workspace'); mkdirSync(cwd) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const input = (content: string | null = '{}'): NativeTrustInput => ({ engine: 'claude', cwd, home: root, userHome: root,
  files: [{ file: join(root, '.claude.json'), directory: root, content },
    { file: join(cwd, '.claude/settings.local.json'), directory: join(cwd, '.claude'), content: null }],
})

it('prepares indexed bytes without writing the native files', () => {
  writeFileSync(join(root, '.claude.json'), 'original')
  const prepared = prepareNativeTrust(input('{"unrelated":true}'), () => true)!
  expect(prepared.files.map(file => file.index)).toEqual([0, 1])
  expect(JSON.parse(prepared.files[0].content!)).toMatchObject({ unrelated: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } })
  expect(readFileSync(join(root, '.claude.json'), 'utf8')).toBe('original')
})

it('keeps absent, malformed and explicitly shaped native settings unchanged', () => {
  for (const text of [null, '{', '[]', '{"projects":[]}', `{"projects":{${JSON.stringify(cwd)}:"mine"}}`]) {
    expect(prepareNativeTrust(input(text), () => true)?.files[0].content).toBe(text)
  }
  const codex: NativeTrustInput = { engine: 'codex', cwd, home: root,
    files: [{ file: join(root, 'config.toml'), directory: root, content: `[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"\n` }] }
  expect(prepareNativeTrust(codex, () => true)?.files[0].content).toBe(codex.files[0].content)
  expect(prepareNativeTrust(input(), () => false)).toBeNull()
})

it('keeps user and project MCP choices, including malformed settings, and never approves names', () => {
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { approved: {}, rejected: {}, fresh: {} } }))
  const settings = { ...input(), files: [...input().files] }
  settings.files[1] = { ...settings.files[1], content: '{"unrelated":3,"disabledMcpjsonServers":["previous"]}' }
  writeFileSync(join(root, 'settings.json'), '{"enabledMcpjsonServers":["approved"],"disabledMcpjsonServers":["rejected"]}')
  expect(JSON.parse(prepareNativeTrust(settings, () => true)!.files[1].content!))
    .toEqual({ unrelated: 3, disabledMcpjsonServers: ['previous', 'fresh'] })
  writeFileSync(join(root, 'settings.json'), '{"enableAllProjectMcpServers":true}')
  expect(prepareNativeTrust(settings, () => true)!.files[1].content).toBe(settings.files[1].content)
  writeFileSync(join(root, 'settings.json'), '{')
  expect(prepareNativeTrust(settings, () => true)).toBeNull()
  writeFileSync(join(root, 'settings.json'), '{}')
  settings.files[1] = { ...settings.files[1], content: '{' }
  expect(prepareNativeTrust(settings, () => true)!.files[1].content).toBe('{')
})

it('defaults inherited MCP to disabled with no existing user or workspace settings', () => {
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"fresh":{}}}')
  expect(JSON.parse(prepareNativeTrust(input(), () => true)!.files[1].content!)).toEqual({ disabledMcpjsonServers: ['fresh'] })
})

it('handles a read removed before capture and rejects revocation during final evidence validation', () => {
  const file = join(root, '.mcp.json'), user = join(root, 'settings.json')
  writeFileSync(file, '{}')
  const inspect = nativeFiles.inspectHookFile
  vi.spyOn(nativeFiles, 'inspectHookFile').mockImplementationOnce((path, mode) => {
    rmSync(file)
    return inspect(path, mode)
  })
  expect(prepareNativeTrust(input(), () => true)).not.toBeNull()
  writeFileSync(file, '{"mcpServers":{"fresh":{}}}'); writeFileSync(user, '{}')
  let active = true
  vi.mocked(nativeFiles.inspectHookFile).mockImplementation((path, mode) => {
    const captured = inspect(path, mode)
    return path === user ? { ...captured, verify() { captured.verify(); active = false } } : captured
  })
  expect(prepareNativeTrust(input(), () => active)).toBeNull()
})

it('bounds files, names, paths, candidates and ancestry before granting trust', () => {
  const valid = input()
  expect(boundedTrustInput(valid)).toBe(true)
  for (const bad of [null, [], { ...valid, extra: true }, { ...valid, engine: 'pi' }, { ...valid, cwd: 'relative' },
    { ...valid, userHome: undefined }, { ...valid, files: [] },
    { ...valid, files: [{ ...valid.files[0], content: 'x'.repeat(1024 * 1024 + 1) }, valid.files[1]] },
    { ...valid, files: [{ ...valid.files[0], file: join(root, 'unowned') }, valid.files[1]] }]) expect(boundedTrustInput(bad)).toBe(false)
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`s${n}`, {}])) }))
  expect(prepareNativeTrust(valid, () => true)).toBeNull()
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { ['x'.repeat(4097)]: {} } }))
  expect(prepareNativeTrust(valid, () => true)).toBeNull()
  rmSync(join(root, '.mcp.json'))
  const deep = join(cwd, ...Array.from({ length: 65 }, () => 'd')); mkdirSync(deep, { recursive: true })
  const nested = { ...input(), cwd: deep, files: [...input().files] }
  nested.files[1] = { ...nested.files[1], file: join(deep, '.claude/settings.local.json'), directory: join(deep, '.claude') }
  expect(prepareNativeTrust(nested, () => true)).toBeNull()
})

it('inherits only accepted source trust within the same repository', () => {
  const source = join(root, 'source'); mkdirSync(source)
  const requested = { ...input(), source }
  expect(prepareNativeTrust(requested, () => true)).toBeNull()
  expect(prepareNativeTrust({ ...requested, files: [{ ...requested.files[0], content: null }, requested.files[1]] }, () => true)).toBeNull()
  const accepted = { ...requested, files: [{ ...requested.files[0],
    content: JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }) }, requested.files[1]] }
  expect(prepareNativeTrust(accepted, () => true)).not.toBeNull()
  mkdirSync(join(source, '.git'))
  expect(prepareNativeTrust(accepted, () => true)).toBeNull()
})

it('rejects oversized or changed read evidence and cancellation during its bounded walk', () => {
  const file = join(root, '.mcp.json')
  writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
  expect(() => prepareNativeTrust(input(), () => true)).toThrow()
  writeFileSync(file, '{}')
  let calls = 0
  expect(() => prepareNativeTrust(input(), () => ++calls === 1)).toThrow('Preparation revoked')
  calls = 0
  expect(() => prepareNativeTrust(input(), () => {
    if (++calls === 3) writeFileSync(file, '{"changed":true}')
    return true
  })).toThrow()
  const large = JSON.stringify({ mcpServers: {}, padding: 'x'.repeat(1024 * 1024 - 100) })
  const deep = join(root, 'a/b/c/d/e/workspace'); mkdirSync(deep, { recursive: true })
  for (let above = dirname(deep); above !== root; above = dirname(above)) writeFileSync(join(above, '.mcp.json'), large)
  const nested = { ...input(), cwd: deep, files: [...input().files] }
  nested.files[1] = { ...nested.files[1], file: join(deep, '.claude/settings.local.json'), directory: join(deep, '.claude') }
  expect(() => prepareNativeTrust(nested, () => true)).toThrow('Trust evidence exceeds its limit')
})
