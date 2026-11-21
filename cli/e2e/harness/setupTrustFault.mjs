// Fault only optional trust replies, so mandatory native-hook preparation can still finish.
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
const at = process.argv.indexOf('__service'), root = process.env.HARNESS_E2E_SETUP_TRUST_ROOT
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
  const original = JSON.stringify, flag = join(root, 'setup-trust-fault')
  JSON.stringify = function(value, replacer, space) {
    if (value?.type === 'setup_trust_prepare_result' || value?.type === 'setup_trust_commit_result') {
      appendFileSync(join(root, 'setup-trust-operations'), value.type + '\n', { mode: 0o600 })
      const mode = readFileSync(flag, 'utf8')
      writeFileSync(flag + '.observed', mode, { mode: 0o600 })
      if (mode === 'unavailable') value = { ...value, payload: { error: 'UNSUPPORTED' } }
      // An unanswered trust request expires while the service remains able to prepare required hooks.
      if (mode === 'late') value = { ...value, type: 'fixture_unanswered_trust' }
      if (mode === 'malformed' && value.type === 'setup_trust_commit_result') {
        value = { ...value, payload: { ...value.payload, files: { version: 1, files: [{ index: 99, content: 'fixture' }] } } }
      }
    }
    return original.call(this, value, replacer, space)
  }
}
