// A separate legacy-protocol writer owns the lock until the caller's event loop releases it.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const directory = process.argv[2]
const lock = path.join(directory, 'registry.json.lock')
const token = crypto.randomUUID()
const release = () => {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
    if (owner.token === token) fs.rmSync(lock, { recursive: true, force: true })
  } catch {}
}
// A caller's write resolves before its lock cleanup finishes, so the lock may still be
// taken here; wait for its removal as a legacy writer would. Watch before trying, so a
// removal between the attempt and the watch is still seen.
const watcher = fs.watch(directory)
const take = () => {
  try { fs.mkdirSync(lock, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') return false; throw error }
  watcher.close()
  const descriptor = fs.openSync(path.join(lock, 'owner.json'), 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startMarker: '', token }))
    fs.fsyncSync(descriptor)
  } finally { fs.closeSync(descriptor) }
  process.send('locked')
  return true
}
process.on('message', message => {
  if (message !== 'release') return
  release()
  process.send?.('released', () => process.disconnect())
})
process.on('disconnect', () => { release(); process.exit(0) })
process.on('SIGTERM', () => {
  if (process.argv[3] === 'ignore-term') { process.send?.('ignored-term'); return }
  release(); process.exit(0)
})
// This helper must not outlive a failed test or a parent that never releases it.
setTimeout(() => { release(); process.exit(2) }, 20_000).unref()
watcher.on('change', take)
if (!take()) process.send('waiting')
