// Private acceptance fixture: observe or fault only the exact setup service's file replies.
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

const at = process.argv.indexOf('__service'), root = process.env.HARNESS_E2E_SETUP_FILES_ROOT
const fixture = () => {
  if (process.env.NODE_ENV !== 'test' || !root || !isAbsolute(root) || at < 2
    || process.argv.length !== at + 2 || process.argv[at + 1] !== 'engineSetup') return false
  try {
    const info = statSync(root)
    return realpathSync(root) === root && info.isDirectory() && (info.mode & 0o077) === 0
      && (process.getuid === undefined || info.uid === process.getuid())
      && realpathSync(process.env.HOME).startsWith(root + sep)
  } catch { return false }
}
if (fixture()) {
  const original = JSON.stringify, flag = join(root, 'setup-files-fault'), seen = flag + '.observed'
  JSON.stringify = function (value, replacer, space) {
    const type = value?.type
    if (type === 'setup_files_prepare_result' || type === 'setup_files_commit_result') {
      appendFileSync(join(root, 'setup-files-operations'), original({ type, pid: process.pid }) + '\n', { mode: 0o600 })
      const mode = existsSync(flag) ? readFileSync(flag, 'utf8') : ''
      if (type === 'setup_files_prepare_result' && value.payload?.preparation && (mode === 'kill' || mode === 'freeze')) {
        writeFileSync(seen, original({ type, pid: process.pid }), { mode: 0o600 })
        process.kill(process.pid, mode === 'kill' ? 'SIGKILL' : 'SIGSTOP')
      }
      if (type === 'setup_files_commit_result' && value.payload?.files && mode === 'malformed') {
        writeFileSync(seen, original({ type, pid: process.pid }), { mode: 0o600 })
        value = { ...value, payload: { ...value.payload, files: { version: 1, files: [{ index: 99, content: 'fixture' }] } } }
      }
    }
    return original.call(this, value, replacer, space)
  }
}
