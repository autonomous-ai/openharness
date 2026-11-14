import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ROOT = resolve(import.meta.dirname, '../..')
const VITEST = join(CLI_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

let root = ''

afterEach(() => {
  // A read-only folder the setup left behind is made writable again first, or this removal would fail on it too.
  if (root) for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o755)
  rmSync(root, { recursive: true, force: true })
})

/** A test file that passes or fails, and whose own afterAll records the folders vitest.setup.ts gave it into `<name>.json`,
 *  with whether each is still there for it. Its test leaves a read-only folder with a file in its runtime folder, as the
 *  managed grid's install leaves its bin/ (lib/runtimeInstall.ts `readOnly`), which a recursive removal cannot empty. */
const fixture = (name: string, passes: boolean) => `
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
afterAll(() => {
  const folders = [process.env.HOME, process.env.ADAPTER_DATA_DIR, process.env.ADAPTER_RUNTIME_DIR]
  writeFileSync(${JSON.stringify(`${name}.json`)}, JSON.stringify(folders.map((folder) => [folder, existsSync(folder)])))
})
test('${name}', () => {
  const bin = join(process.env.ADAPTER_RUNTIME_DIR, 'grid-0.0.0-test', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'grid'), '')
  chmodSync(bin, 0o555)
  expect(${passes}).toBe(true)
})
`

describe('vitest.setup.ts', () => {
  it("removes the home, data and runtime folders it made, read-only folders and all, after the file's own afterAll, when it passes and when it fails", async () => {
    root = mkdtempSync(join(tmpdir(), 'setup-folders-'))
    const temp = join(root, 'tmp'), project = join(root, 'project')
    mkdirSync(temp)
    mkdirSync(project)
    writeFileSync(join(project, 'vitest.config.mjs'),
      `export default { test: { globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(join(CLI_ROOT, 'vitest.setup.ts'))}] } }\n`)
    writeFileSync(join(project, 'passes.test.mjs'), fixture('passes', true))
    writeFileSync(join(project, 'fails.test.mjs'), fixture('fails', false))
    // The child's own os.tmpdir(), and nothing of this worker's Vitest to make it think it runs inside one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')))
    const code = await new Promise<number | null>((done) => {
      execFile(process.execPath, [VITEST, 'run'], { cwd: project, env: { ...env, TMPDIR: temp, TEMP: temp, TMP: temp }, timeout: 60_000 },
        (error) => done(error ? (typeof error.code === 'number' ? error.code : null) : 0))
    })

    expect(code).toBe(1)
    const recorded = ['passes', 'fails'].flatMap((name) => JSON.parse(readFileSync(join(project, `${name}.json`), 'utf8')) as Array<[string, boolean]>)
    expect(recorded).toHaveLength(6)
    // Each was the file's own, in the child's temporary folder, and still there for the file's own afterAll.
    for (const [folder, there] of recorded) expect([folder.startsWith(temp), there]).toEqual([true, true])
    const made = recorded.map(([folder]) => folder)
    expect(made.filter((folder) => existsSync(folder))).toEqual([])
    expect(readdirSync(temp).filter((name) => name.startsWith('adapter-test-'))).toEqual([])
  }, 90_000)
})
