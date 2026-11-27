/**
 * Before a release is uploaded (scripts/upload-cli.sh, and staging's scripts/publish-cli-staging.sh): inbox.mjs, the
 * dial's inbox follower that harness.exe runs on its own on Windows, must load and refuse an id that is not a
 * session's with `{"off":true}` and exit 0, the answer harness.exe, the updaters' canary and install.ps1 rely on
 * (src/inboxEntry.ts). The shebang and lean-bundle checks cover cli.js only (Ken's review of #4681).
 *
 * Its config import moves legacy state in HOME (migrateLegacyAdapterState), so it runs in a throwaway home and data
 * folder, removed after, and for at most 15 s, the canary's bound (src/lib/selfUpdate.ts).
 *
 *   node scripts/check-inbox-bundle.mjs dist/inbox.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const inbox = resolve(process.argv[2] ?? 'dist/inbox.mjs')
const root = mkdtempSync(join(tmpdir(), 'inbox-check-'))
try {
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id') }
  const run = spawnSync(process.execPath, [inbox, 'device', 'claude', 'inbox', 'not-a-session-id'], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
  })
  // Named by the check alone: what the bundle printed is not the release log's to repeat.
  const why = run.error?.code === 'ETIMEDOUT' ? 'gave no answer in 15 s'
    : run.status !== 0 ? `exited ${run.status ?? run.signal}`
    : run.stdout !== '{"off":true}\n' ? 'did not answer {"off":true}'
    : null
  if (why) {
    console.error(`error: ${inbox}: the inbox follower's check (device claude inbox not-a-session-id) ${why}`)
    process.exitCode = 1
  } else {
    console.log('>> inbox.mjs: a refused id answers {"off":true} and exits 0')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
