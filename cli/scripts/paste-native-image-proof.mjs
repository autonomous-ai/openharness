// Native prerequisite only: private bytes and, when requested, a uniquely named private pasteboard.
// The general clipboard is never opened. The earlier AppleScript PNGf failure remains recorded separately.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('PASTE_IMAGE_PROOF_MACOS_REQUIRED')
const privatePasteboard = process.argv.includes('--private-pasteboard')
assert.ok(process.argv.slice(2).every((arg) => arg === '--private-pasteboard'), 'PASTE_IMAGE_PROOF_UNKNOWN_OPTION')
const root = mkdtempSync(join(tmpdir(), 'paste-native-image-proof-'))
const home = join(root, 'home'), temporary = join(root, 'tmp')
mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPa0AAAAASUVORK5CYII=', 'base64')
const source = join(root, 'source.png')
let descriptor
try {
  writeFileSync(source, png, { flag: 'wx', mode: 0o600 })
  descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  unlinkSync(source)
  writeFileSync(source, 'replacement is not the PNG', { flag: 'wx', mode: 0o600 })
  const script = `ObjC.import('Foundation');
const handle = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, true);
const data = handle.readDataOfLength(8388609);
handle.closeFile;
if (Number(data.length) < 1 || Number(data.length) > 8388608) throw Error('PASTE_IMAGE_PROOF_BODY_LIMIT');
${privatePasteboard ? `ObjC.import('AppKit');
const board = $.NSPasteboard.pasteboardWithUniqueName;
if (typeof board.setDataForType !== 'function') throw Error('PASTE_IMAGE_PROOF_BOARD_UNAVAILABLE: ' + String(board));
let answer;
try {
  board.clearContents;
  if (!board.setDataForType(data, $('public.png'))) throw Error('PASTE_IMAGE_PROOF_BOARD_WRITE');
  const copied = board.dataForType($('public.png'));
  if (!copied || !copied.isEqualToData(data)) throw Error('PASTE_IMAGE_PROOF_BOARD_READ');
  answer = ObjC.unwrap(copied.base64EncodedStringWithOptions(0));
} finally { board.releaseGlobally; }
answer;` : 'ObjC.unwrap(data.base64EncodedStringWithOptions(0));'}`
  const result = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary },
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
      })
    } finally { closeSync(descriptor); descriptor = undefined }
    let stdout = '', stderr = '', failure
    const timer = setTimeout(() => { failure = 'PASTE_IMAGE_PROOF_TIMEOUT'; child.kill('SIGKILL') }, 5_000)
    for (const [stream, append] of [[child.stdout, (value) => { stdout += value }], [child.stderr, (value) => { stderr += value }]]) {
      stream.on('data', (bytes) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.length > 4096) {
          failure = 'PASTE_IMAGE_PROOF_OUTPUT_LIMIT'; child.kill('SIGKILL')
        } else append(bytes.toString('utf8'))
      })
    }
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (failure) reject(new Error(failure))
      else resolve({ code, signal, stdout, stderr })
    })
  })
  assert.equal(result.code, 0, `PASTE_IMAGE_PROOF_FAILED: ${result.stderr.trim()}`)
  assert.equal(result.stderr, '')
  assert.deepEqual(Buffer.from(result.stdout.trim(), 'base64'), png, 'PASTE_IMAGE_PROOF_WRONG_BYTES')
  process.stdout.write(JSON.stringify({ proof: privatePasteboard ? 'JXA private named PNG pasteboard' : 'JXA inherited descriptor',
    passed: true, bytes: png.length, originalPathReplaced: true, generalClipboardAccess: false, privateHome: true }) + '\n')
} finally {
  if (descriptor !== undefined) closeSync(descriptor)
  rmSync(root, { recursive: true, force: true })
}
