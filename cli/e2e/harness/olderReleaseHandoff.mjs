// What an older release's own update handoff does, for e2e/updateOnItsOwn.e2e.ts: it spawns the new build's
// core (`cli.js __run`, detached, told ADAPTER_UPDATED_TO), waits for it to claim the pid file, judges it
// a while longer (the release waits for its connection), and leaves. Releases before harnessd's master did
// exactly this, and so do later ones run without a master; the core it leaves behind has no master.
//
// Usage: node olderReleaseHandoff.mjs <cli.js> <pid file> <file whose presence lets it leave>
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const [cli, pidFile, mayLeave] = process.argv.slice(2)
const core = spawn(process.execPath, [cli, '__run'], {
  detached: true, stdio: 'inherit', env: { ...process.env, ADAPTER_UPDATED_TO: process.env.HANDED_OVER_VERSION ?? '0.0.0' },
})
core.unref()
const deadline = Date.now() + 120_000
const judged = setInterval(() => {
  let claimed = false
  try { claimed = Number(readFileSync(pidFile, 'utf8').trim()) === core.pid } catch { /* not yet */ }
  if (claimed && existsSync(mayLeave)) { clearInterval(judged); process.exit(0) }
  if (Date.now() > deadline) process.exit(1)
}, 200)
