/** The Claude app's store read (`ClaudeAppStore`): a first read of 16 and of 200 session files, and the read after one
 * changed file. Only on a fixture store in a throwaway folder: never the Claude app's own, never a real home. Each
 * store is this OS's first root under a throwaway home of its own, read with every root of that home, so a Windows run
 * measures the walk of both.
 * Run from cli/: node --import tsx scripts/benchmark-claude-app-store.ts [output.json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const output = process.argv[2]

// A throwaway home before any module of the tree loads: a module that resolves a path under the home at load time
// lands here, never in the person's own.
const home = mkdtempSync(join(tmpdir(), 'harness-claude-app-store-'))
process.env.HOME = home
process.env.USERPROFILE = home
for (const [name, folder] of [['ADAPTER_DATA_DIR', 'data'], ['ADAPTER_RUNTIME_DIR', 'runtime'], ['HARNESS_AUTH_DIR', 'auth']]) {
  process.env[name] = join(home, folder)
  mkdirSync(process.env[name]!)
}
delete process.env.HARNESS_ENV_FILE
delete process.env.DOTENV_CONFIG_PATH

// The spec's "about 40 KB each".
const FILE_BYTES = 40_000
const ROUNDS = 21
const START = 1_794_000_000_000

interface Case { name: string; files: number; rounds: number; medianMs: number; maxMs: number; parsed: number }

try {
  const { ClaudeAppStore } = await import('../src/cable/hosts/claudeAppStore.js')
  const { claudeAppFixture } = await import('../src/testing/claudeAppFixture.js')
  const { claudeStoreRoots } = await import('../src/cable/hosts/appPlaces.js')

  const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
  /** A store of `count` files, none archived, mtimes one second apart, in the first root under `caseHome`: every root
   *  of that home, and `write`, which rewrites its newest file at an mtime and gives that file's path. */
  function store(caseHome: string, count: number): { write: (mtime: number) => string; roots: string[] } {
    const roots = claudeStoreRoots(platform(), {}, caseHome).map(({ root }) => root)
    const fixture = claudeAppFixture(roots[0]!)
    const write = (i: number, mtime: number): string => fixture.write(
      { localId: `local_${uuid(i)}`, cliSessionId: uuid(i), cwd: `/work/project-${i}`, title: `Session ${i}`, lastActivityAt: mtime },
      { mtime, bytes: FILE_BYTES })
    for (let i = 0; i < count; i++) write(i, START + i * 1000)
    return { roots, write: (mtime) => write(count - 1, mtime) }
  }

  const round2 = (n: number): number => Math.round(n * 100) / 100
  /** `before` runs untimed ahead of each round: the app's write is the app's cost, not the read's. */
  async function measure(name: string, files: number, run: () => Promise<number>, before = (): void => {}): Promise<Case> {
    const times: number[] = []
    let parsed = 0
    for (let round = 0; round < ROUNDS; round++) {
      before()
      const start = performance.now()
      parsed = await run()
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    return { name, files, rounds: ROUNDS, medianMs: round2(times[Math.floor(ROUNDS / 2)]!), maxMs: round2(times[ROUNDS - 1]!), parsed }
  }

  const first = (roots: string[]) => async (): Promise<number> => {
    const reader = new ClaudeAppStore(roots)
    await reader.folders()
    await reader.files()
    return (await reader.read()).parsed
  }

  const small = store(join(home, 'home-16'), 16)
  const large = store(join(home, 'home-200'), 200)
  const cases = [await measure('first-16', 16, first(small.roots)), await measure('first-200', 200, first(large.roots))]

  const reader = new ClaudeAppStore(large.roots)
  await reader.folders()
  await reader.files()
  await reader.read()
  // Each round's write is newer than the last, as a working turn's are.
  let mtime = START + 200 * 1000
  let path = ''
  cases.push(await measure('changed-1', 200, async () => {
    await reader.touch(dirname(path), basename(path))
    return (await reader.read()).parsed
  }, () => { mtime += 1000; path = large.write(mtime) }))

  const result = { node: process.version, platform: platform(), arch: arch(), fileBytes: FILE_BYTES, cases }
  console.log(JSON.stringify(result, null, 2))
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
