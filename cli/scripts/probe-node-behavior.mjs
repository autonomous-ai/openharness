#!/usr/bin/env node
// Re-measures the Node behavior the code documents as measured on Node 22.23. Run it on each Node the
// installers ship and read each line: `ok` = still as documented, `changed` = the code's comment is stale.
// Not run by CI; the output goes in the PR that moves the runtime.
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, renameSync, statSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const lines = []
const report = (name, ok, seen) => { lines.push(`${ok ? 'ok     ' : 'changed'} ${name}: ${seen}`) }
const dir = mkdtempSync(join(tmpdir(), 'probe-node-'))

// kit/zstdFrames.ts: the decoder accepted a truncated final block.
{
  const raw = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 2654435761) >>> 24))
  const whole = zlib.zstdCompressSync(raw)
  const cut = whole.subarray(0, whole.length - 1000)
  let seen
  try {
    const out = zlib.zstdDecompressSync(cut, { finishFlush: zlib.constants.ZSTD_e_end })
    seen = `accepted, ${out.length} of ${raw.length} bytes`
  } catch (err) { seen = `threw ${err.code ?? err.name}` }
  report('zstd truncated final block silently accepted', seen.startsWith('accepted'), seen)
}

// harnessd/reexec.ts, masterProcess.ts: process.execve of a missing node binary aborts (134); a missing script is MODULE_NOT_FOUND.
if (typeof process.execve !== 'function') report('process.execve missing binary', process.platform === 'win32', 'process.execve absent')
else {
  const missingBin = spawnSync(process.execPath, ['-e', `process.execve('${join(dir, 'no-node')}', ['x'], process.env)`], { encoding: 'utf8' })
  report('process.execve missing node binary aborts (134)', missingBin.status === null && missingBin.signal === 'SIGABRT' || missingBin.status === 134,
    `status ${missingBin.status} signal ${missingBin.signal}`)
  const missingScript = spawnSync(process.execPath, ['-e', `process.execve(process.execPath, [process.execPath, '${join(dir, 'no.js')}'], process.env)`], { encoding: 'utf8' })
  report('process.execve missing script is MODULE_NOT_FOUND', /MODULE_NOT_FOUND/.test(missingScript.stderr),
    `status ${missingScript.status} signal ${missingScript.signal}`)
}

// lib/sleepAware.ts: the clocks keep counting through a sleep. A real sleep needs a lid or `pmset sleepnow`,
// so this awake run only checks that performance.now() and Date.now() advance together; a human sleep run
// compares the two gaps.
{
  const p0 = performance.now(), d0 = Date.now()
  await new Promise((r) => setTimeout(r, 500))
  const dp = performance.now() - p0, dd = Date.now() - d0
  report('performance.now() tracks Date.now() (awake only)', Math.abs(dp - dd) < 50, `performance ${dp.toFixed(0)}ms, Date ${dd}ms`)
}

// lib/patientExec.ts: a child that answered while the loop was held is reported as exit 0 with empty stdout.
{
  const seen = await new Promise((resolve) => {
    execFile(process.execPath, ['-e', 'console.log("answer")'], { timeout: 1000 }, (err, stdout) => {
      resolve(`err ${err ? err.code ?? err.message : 'null'}, stdout ${JSON.stringify(stdout)}`)
    })
    setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000) })
  })
  report('held loop: child exit 0 with empty stdout', seen === 'err null, stdout ""', seen)
}

// kit/windowsFiles.ts: a read-write open of an NTFS file changes ctime even without a write.
if (process.platform === 'win32') {
  const file = join(dir, 'a.json'), moved = join(dir, 'b.json')
  writeFileSync(file, '{}')
  renameSync(file, moved)
  const before = statSync(moved).ctimeMs
  await new Promise((r) => setTimeout(r, 50))
  closeSync(openSync(moved, 'r+'))
  const after = statSync(moved).ctimeMs
  report('NTFS ctime changes on read-write open without write', after !== before, `ctime ${before} -> ${after}`)
} else lines.push('skipped NTFS ctime (Windows only)')

// lib/sqliteRead.ts: node:sqlite is there without a flag and takes a busy timeout.
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'p.db'))
  db.exec('PRAGMA busy_timeout = 123')
  const pragma = db.prepare('PRAGMA busy_timeout').get()
  let option
  try { new DatabaseSync(join(dir, 'p2.db'), { timeout: 77 }).close(); option = 'option timeout accepted' } catch (err) { option = `option timeout ${err.code ?? err.name}` }
  db.close()
  report('node:sqlite available, PRAGMA busy_timeout works', Object.values(pragma)[0] === 123, `${JSON.stringify(pragma)}; ${option}`)
} catch (err) { report('node:sqlite available', false, String(err.code ?? err.message)) }

rmSync(dir, { recursive: true, force: true })
console.log(`node ${process.version} ${process.platform}-${process.arch}`)
console.log(lines.join('\n'))
