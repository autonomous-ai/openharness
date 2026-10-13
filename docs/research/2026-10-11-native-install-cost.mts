/** Private immutable installer histories; no engine, package manager, daemon or tmux. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-install-cost-')))
Object.defineProperty(process, 'platform', { value: 'linux' })
Object.assign(childProcess, Object.fromEntries(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']
  .map(key => [key, () => { throw Error('A host subprocess is forbidden in this measurement') }])))
syncBuiltinESMExports()
for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'TMUX_TMPDIR', 'ZDOTDIR']) {
  process.env[key] = join(root, key); mkdirSync(process.env[key]!, { mode: 0o700 })
}
process.env.SHELL = '/bin/sh'; process.env.PATH = '/fixture/bin'; process.env.TZ = 'UTC'
process.env.HARNESS_CONNECTIONS_PORT = '0'
delete process.env.TMUX; delete process.env.TMUX_PANE
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const cli = process.env.NATIVE_INSTALL_COST_CLI ?? resolve('cli')
const { createNativeInstallations } = await import(pathToFileURL(join(cli, 'src/engines/kit/nativeInstall.ts')).href)
try {
  for (const count of [1, 32, 128, 1000]) {
    const directory = join(root, `history-${count}`), environment = { HOME: process.env.HOME!, PATH: '/fixture/bin', SHELL: '/bin/sh' }
    const recipe = { command: 'private-fixture-install', source: 'fixture', executable: { names: ['private-fixture-engine'] } }
    let dispatches = 0
    const controller = createNativeInstallations({ directory, node: () => '/fixture/node', dispatch: () => { dispatches++ } })
    await controller.ensure('opencode', recipe, environment, 'seed', () => true)
    const seed = JSON.parse(readFileSync(join(directory, '00000000.json'), 'utf8'))
    let previous: { file: string; digest: string }[] = []
    for (let index = 0; index < count; index++) {
      const prefix = String(index).padStart(8, '0'), file = join(directory, `${prefix}.json`), witness = `${directory}.${prefix}.dispatch`
      const claim = { ...seed, request: index === 0 ? 'measured-request' : `fixture-${index}`, token: `fixture-token-${index}`, previous, witness }
      const bytes = JSON.stringify(claim), digest = hash(bytes)
      const marker = JSON.stringify({ token: claim.token, claim: digest, kind: 'run' })
      const result = JSON.stringify({ token: claim.token, claim: digest, code: 0, signal: null })
      for (const [path, value] of [[file, bytes], [witness, marker], [`${file}.dispatch`, marker], [`${file}.result`, result]]) {
        writeFileSync(path, value, { mode: 0o600 })
      }
      previous = [{ file, digest }, { file: `${file}.result`, digest: hash(result) }]
    }
    dispatches = 0
    let last = performance.now(), maxCallbackMs = 0
    const timer = setInterval(() => { const now = performance.now(); maxCallbackMs = Math.max(maxCallbackMs, now - last); last = now }, 1)
    const cpu = process.cpuUsage(), start = performance.now()
    const result = await controller.ensure('opencode', recipe, environment, 'measured-request', () => true)
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu)
    await new Promise(done => setTimeout(done, 2)); clearInterval(timer)
    process.stdout.write(JSON.stringify({ count, result, dispatches, wallMs, cpuMs: (used.user + used.system) / 1000,
      maxCallbackMs, rssMiB: process.memoryUsage().rss / 1048576 }) + '\n')
  }
} finally { rmSync(root, { recursive: true, force: true }) }
