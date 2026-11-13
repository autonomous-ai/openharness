/**
 * The `harness` launcher follows the Node the daemon runs on, on the real daemon (lib/nodeReferences.ts): an update can
 * move the managed Node, and the launcher was written with one in it. An installed copy's master points it at the
 * Node its core came up on (masterProcess.ts `coreUp`). The core did that itself until the audit of 2026-11-12, and
 * loaded the platform's launchd, systemd and Task Scheduler code to do it.
 *
 * An installed copy here: a bundle built from this checkout in the CLI's folder, run on a copy of this Node under the
 * runtime folder, with a launcher in the bin folder that names a Node from before. A core with no master leaves the
 * launcher as it is: nothing moves its Node, since it gets no updates (core/updateHandoff.ts).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

describe.skipIf(process.platform === 'win32')('the launcher follows the Node the daemon runs on', { timeout: 240_000 }, () => {
  let scratch = ''
  let daemon: IsolatedDaemon | undefined
  const cli = () => join(scratch, 'cli')
  const launcher = () => join(scratch, 'bin', 'harness')
  /** A managed Node: this Node, copied under the runtime folder as an install of it is laid out. */
  const node = () => join(scratch, 'runtime', `node-v${process.versions.node}-e2e`, 'bin', 'node')
  const before = () => `#!/bin/sh\nexec '${join(scratch, 'runtime', 'node-v20.0.0-gone', 'bin', 'node')}' '${join(cli(), 'cli.js')}' "$@"\n`
  const environment = () => ({ ADAPTER_CLI_DIR: cli(), ADAPTER_RUNTIME_DIR: join(scratch, 'runtime'), HARNESS_BIN_DIR: join(scratch, 'bin'), ADAPTER_UPDATE_DISABLE: 'true' })

  beforeAll(() => {
    // Its real path: a daemon's Node is named by its real path, and macOS's temporary folder is behind a link.
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harnessd-node-references-')))
    for (const dir of [cli(), join(scratch, 'bin'), join(node(), '..')]) mkdirSync(dir, { recursive: true })
    // The run's bundle (`E2E_BUNDLE`, see harness/bundle.ts), or one built here.
    const built = process.env.E2E_BUNDLE_PATH ?? (() => {
      const out = join(scratch, 'build')
      execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: out }, stdio: 'pipe' })
      return join(out, 'cli.js')
    })()
    copyFileSync(built, join(cli(), 'cli.js'))
    writeFileSync(join(cli(), 'package.json'), '{"type":"module"}\n')
    copyFileSync(process.execPath, node(), constants.COPYFILE_FICLONE)
    chmodSync(node(), 0o755)
  }, 180_000)
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

  const start = async (noMaster: boolean) => {
    writeFileSync(launcher(), before(), { mode: 0o755 })
    const d = await IsolatedDaemon.create({ scriptPath: join(cli(), 'cli.js'), node: node(), noMaster,
      env: { ...environment(), ...(noMaster ? { HARNESS_NO_MASTER: '1' } : {}) } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }

  it('an installed copy\'s master points the launcher at the Node its core came up on', async () => {
    const d = await start(false)
    await until('the launcher to name the Node the daemon runs on', () => readFileSync(launcher(), 'utf8').includes(`exec '${node()}' `) || null, 60_000, 200)
    expect(readFileSync(launcher(), 'utf8')).toBe(before().replace(/^exec .*$/m, `exec '${node()}' '${join(cli(), 'cli.js')}' "$@"`))
    // Said by the master, which did it: the core's process no longer holds that code.
    expect(d.log()).toMatch(new RegExp(`\\[node-runtime\\] ✓ repointed ${launcher().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at `))
  })

  it('a core with no master leaves the launcher as it is', async () => {
    await start(true)
    expect(readFileSync(launcher(), 'utf8')).toBe(before())
  })
})
