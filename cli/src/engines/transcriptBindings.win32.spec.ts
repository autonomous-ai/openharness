// An unwritten Claude transcript on Windows paths, on any OS: node:path is Windows' and lstat answers as NTFS does
// (engines/kit/nativePaths.windows.spec.ts), case-blind, with a junction reported as a symbolic link.
import * as fs from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:path', async original => {
  const real = await original<typeof import('node:path')>()
  return { ...real.win32, default: real.win32, win32: real.win32, posix: real.posix }
})
vi.mock('node:fs', async original => ({ ...await original<typeof fs>(), lstatSync: vi.fn(), readlinkSync: vi.fn() }))

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const PROJECTS = 'C:\\Users\\u\\.claude\\projects'
const announced = `c:\\users\\u\\.claude\\projects\\C--work\\${A}.jsonl`
type Kind = 'dir' | 'link'
const tree = new Map<string, { kind: Kind; ino: number }>()
const add = (path: string, kind: Kind = 'dir') => tree.set(path.toLowerCase(), { kind, ino: tree.size + 1 })
const stat = (kind: Kind, ino: number) => ({
  dev: 7n, ino: BigInt(ino), mode: kind === 'dir' ? 0o40666n : 0o120666n, uid: BigInt(process.getuid?.() ?? 0),
  size: 0n, mtimeNs: 1n, ctimeNs: 1n, isDirectory: () => kind === 'dir', isFile: () => false, isSymbolicLink: () => kind === 'link',
})
let bindings: typeof import('./transcriptBindings.js'), roots: ReturnType<typeof bindings.transcriptRootEvidence>
beforeEach(async () => {
  tree.clear()
  for (const path of ['C:\\', 'C:\\Users', 'C:\\Users\\u', 'C:\\Users\\u\\.claude', PROJECTS]) add(path)
  vi.mocked(fs.lstatSync).mockImplementation(((path: string) => {
    const node = tree.get(String(path).toLowerCase())
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return stat(node.kind, node.ino)
  }) as never)
  vi.mocked(fs.readlinkSync).mockImplementation((() => 'D:\\elsewhere\\') as never)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', PROJECTS); vi.resetModules()
  bindings = await import('./transcriptBindings.js')
  roots = bindings.transcriptRootEvidence('claude', undefined, { homes: { claude: [], codex: [] }, verify() {} })
})

it.each(['present', 'absent'])('admits an unwritten Claude transcript under its root spelled in another case, the folder %s', folder => {
  if (folder === 'present') add(`${PROJECTS}\\c--WORK`)
  const result = bindings.transcriptEvidence('claude', announced, undefined, 'derived', undefined, roots)
  expect(result.valid).toBe(true); expect(result.matchingRoots).toEqual(roots.directories); result.verify()
})
it('refuses an unwritten Claude transcript whose folder is a junction', () => {
  add(`${PROJECTS}\\C--work`, 'link')
  expect(() => bindings.transcriptEvidence('claude', announced, undefined, 'derived', undefined, roots)).toThrow('reparse point')
})
it('names a transcript for its session whatever the case of its name', () => {
  expect(bindings.namedForSession(`${PROJECTS}\\C--work\\${A.toUpperCase()}.JSONL`, A)).toBe(true)
})
