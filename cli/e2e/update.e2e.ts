/**
 * A self-update end to end, on real release bundles: the daemon finds a newer build in its manifest,
 * stages it, and harnessd's master restarts the core on it. A build that stays up is kept. One that
 * crashes is rolled back, remembered, and not tried again until a newer one is published — before,
 * every machine on it restarted once a minute until a fix shipped.
 *
 * The bundles are built from this checkout at made-up versions and served from a local manifest, so
 * nothing here reaches beyond the machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const FIRST = '41.0.1'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const count = (text: string, part: string): number => text.split(part).length - 1
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('a self-update under harnessd', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let master: number | null = null
  const releases = new Map<string, Buffer>()
  let notify = Buffer.alloc(0)
  let offered = FIRST
  const downloads: string[] = []
  const cliDir = () => join(scratch, 'cli')
  const installed = () => readFileSync(join(cliDir(), 'cli.js'))
  const rejected = () => JSON.parse(readFileSync(join(cliDir(), 'update-rejected.json'), 'utf8')) as string[]
  const running = async (): Promise<string | null> => {
    const health = await fetch(`http://127.0.0.1:${daemon!.port}/api/health`).then((response) => response.json()).catch(() => null)
    return (health as { version?: string } | null)?.version ?? null
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-update-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: FIRST, BUNDLE_OUT_DIR: out }, stdio: 'pipe',
    })
    const first = readFileSync(join(out, 'cli.js'), 'utf8')
    notify = readFileSync(join(out, 'notify.mjs'))
    // The version is baked in at build time; the others are the same bytes with it swapped.
    expect(count(first, FIRST)).toBeGreaterThanOrEqual(2)
    const release = (version: string, crashesOnStart = false): void => {
      let source = first.replaceAll(FIRST, version)
      // Passes the updater's canary (`cli.js version`), then dies on every start as a core.
      if (crashesOnStart) source = source.replace('\n', '\nif(process.argv[2]==="__run")process.exit(3);\n')
      const file = join(out, `cli-${version}.js`)
      writeFileSync(file, source)
      expect(execFileSync(process.execPath, [file, 'version'], { encoding: 'utf8' }).trim()).toBe(version)
      releases.set(version, Buffer.from(source))
    }
    release(FIRST)
    release('41.0.2')
    release('41.0.3', true)
    release('41.0.4')

    server = createServer((request, response) => {
      const url = request.url ?? ''
      const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      if (url === '/metadata.json') {
        const cli = releases.get(offered)!
        response.end(JSON.stringify({ cli: {
          version: offered,
          cli: { url: `${origin}/cli-${offered}.js`, sha256: sha(cli), size: cli.length },
          notify: { url: `${origin}/notify.mjs`, sha256: sha(notify), size: notify.length },
        } }))
        return
      }
      const asked = /^\/cli-(.+)\.js$/.exec(url)?.[1]
      if (asked && releases.has(asked)) { downloads.push(asked); response.end(releases.get(asked)); return }
      if (url === '/notify.mjs') { response.end(notify); return }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    mkdirSync(cliDir())
    writeFileSync(join(cliDir(), 'cli.js'), releases.get(FIRST)!)
    writeFileSync(join(cliDir(), 'notify.mjs'), notify)
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
    daemon = await IsolatedDaemon.create({
      scriptPath: join(cliDir(), 'cli.js'),
      env: {
        ADAPTER_CLI_DIR: cliDir(),
        ADAPTER_UPDATE_DISABLE: 'false',
        ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000',
        ADAPTER_UPDATE_SLOT_SEC: '-1',
        HARNESSD_UPDATE_PROBATION_MS: '3000',
        HARNESSD_INITIAL_BACKOFF_MS: '100',
        // Every other download an installed daemon looks for stays on this machine too.
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
        ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
      },
    })
    await daemon.start()
    master = daemon.pid
    expect(await running()).toBe(FIRST)
  })

  afterAll(async () => {
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  const showLog = () => onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-120).join('\n')}`) })

  it('keeps a newer build that stays up', async () => {
    showLog()
    offered = '41.0.2'
    await until('the core to run 41.0.2', async () => (await running()) === '41.0.2', 90_000, 250)
    await until('the master to keep it', () => daemon!.log().includes('the update stayed up — keeping it'), 30_000)
    expect(daemon!.log()).toContain('core exited (code 75) for an update — restarting')
    expect(installed()).toEqual(releases.get('41.0.2'))
    expect(existsSync(join(cliDir(), 'cli.js.prev'))).toBe(false)
    expect(existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    expect(existsSync(join(cliDir(), 'update-rejected.json'))).toBe(false)
    expect(daemon!.pid).toBe(master)
  })

  it('rolls back a build that crashes, and never stages it again', async () => {
    showLog()
    const from = daemon!.log().length
    offered = '41.0.3'
    await until('the master to roll it back', () => daemon!.log().slice(from).includes('the updated core failed (code 3) — rolled back'), 90_000)
    await until('the previous build to answer again', async () => (await running()) === '41.0.2', 60_000, 250)
    expect(installed()).toEqual(releases.get('41.0.2'))
    expect(rejected()).toEqual(['41.0.3'])
    expect(existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    await until('the core to say it is waiting for a newer build', () => daemon!.log().slice(from).includes('41.0.3 was rolled back on this machine'), 30_000)
    // A check every second: five more of them, and not one restart.
    const cores = daemon!.coresStarted()
    await sleep(5_000)
    expect(daemon!.coresStarted()).toBe(cores)
    expect(await running()).toBe('41.0.2')
    expect(downloads.filter((version) => version === '41.0.3')).toHaveLength(1)
    expect(count(daemon!.log().slice(from), '41.0.3 was rolled back on this machine')).toBe(1)
    expect(daemon!.pid).toBe(master)
  })

  it('moves on when a newer build is published', async () => {
    showLog()
    offered = '41.0.4'
    await until('the core to run 41.0.4', async () => (await running()) === '41.0.4', 90_000, 250)
    await until('the master to keep it', () => count(daemon!.log(), 'the update stayed up — keeping it') === 2, 30_000)
    expect(installed()).toEqual(releases.get('41.0.4'))
    // Still remembered: only installing it on purpose takes a version off the list.
    expect(rejected()).toEqual(['41.0.3'])
    expect(daemon!.pid).toBe(master)
    expect(IsolatedDaemon.alive(master)).toBe(true)
  })
})
