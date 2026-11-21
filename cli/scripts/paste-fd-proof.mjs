// A read-only native prerequisite for the paste Design. Never reads or writes an OS clipboard.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('PASTE_FD_PROOF_MACOS_REQUIRED')

const root = mkdtempSync(join(tmpdir(), 'paste-fd-proof-'))
const privateHome = join(root, 'home')
const privateTemp = join(root, 'tmp')
mkdirSync(privateHome, { mode: 0o700 })
mkdirSync(privateTemp, { mode: 0o700 })
// A fixed one-pixel PNG, created by this fixture; no owner content or image helper is involved.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa0AAAAASUVORK5CYII=', 'base64')
const source = join(root, 'source.png')
let descriptor
try {
  writeFileSync(source, png, { flag: 'wx', mode: 0o600 })
  descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  // The inherited descriptor must still read the original inode, not this replacement pathname.
  unlinkSync(source)
  writeFileSync(source, 'replacement is not the PNG', { flag: 'wx', mode: 0o600 })
  const script = 'return (read (POSIX file "/dev/fd/3") as «class PNGf»)'
  const result = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('/usr/bin/osascript', ['-e', script], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: privateHome, CFFIXED_USER_HOME: privateHome, TMPDIR: privateTemp },
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
      })
    } finally {
      closeSync(descriptor)
      descriptor = undefined
    }
    let stdout = '', stderr = '', overflow = false
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PASTE_FD_PROOF_TIMEOUT')) }, 5_000)
    for (const [stream, append] of [[child.stdout, (text) => { stdout += text }], [child.stderr, (text) => { stderr += text }]]) {
      stream.on('data', (bytes) => {
        if (stdout.length + stderr.length + bytes.length > 4096) {
          overflow = true
          child.kill('SIGKILL')
        } else append(bytes.toString('utf8'))
      })
    }
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (overflow) reject(new Error('PASTE_FD_PROOF_OUTPUT_LIMIT'))
      else resolve({ code, signal, stdout, stderr })
    })
  })
  assert.equal(result.code, 0, `PASTE_FD_PROOF_READ_FAILED: ${result.stderr.trim()}`)
  assert.equal(result.stderr, '')
  const returned = /^«data PNGf([0-9A-Fa-f]+)»\s*$/.exec(result.stdout)
  assert.ok(returned, 'PASTE_FD_PROOF_TYPED_DATA_MISSING')
  assert.deepEqual(Buffer.from(returned[1], 'hex'), png, 'PASTE_FD_PROOF_WRONG_ARTIFACT')
  process.stdout.write(JSON.stringify({ proof: 'macOS inherited fd 3 PNGf read', passed: true,
    bytes: png.length, originalPathReplaced: true, clipboardAccess: false, privateHome: true }) + '\n')
} finally {
  if (descriptor !== undefined) closeSync(descriptor)
  rmSync(root, { recursive: true, force: true })
}
