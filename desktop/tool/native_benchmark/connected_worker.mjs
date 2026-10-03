// Deterministic terminal workload; launched ONLY in a newly created fixture pane.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = process.env.HARNESS_CONNECTED_ROOT
const index = Number(process.argv[2])
assert(root?.startsWith('/private/tmp/harness-connected-') && dirname(root) === '/private/tmp')
assert(process.env.HOME === join(root, 'home') && process.stdin.isTTY && process.stdout.isTTY)
assert(Number.isInteger(index) && index >= 0 && index < 48)
let timer, mode = 'idle-visible', ticks = 0, bytes = 0, skipped = 0, next = 0
function write(value) { bytes += Buffer.byteLength(value); process.stdout.write(value) }
function state() { return { pid: process.pid, index, mode, ticks, bytes, skipped, at: performance.now() } }
function setMode(value) {
  assert(['idle-visible', 'idle-hidden', 'active'].includes(value))
  clearInterval(timer)
  mode = value
  write(value === 'idle-visible' ? '\x1b[?25h' : '\x1b[?25l')
  if (value === 'active') {
    next = performance.now() + 50
    timer = setInterval(() => {
      const now = performance.now()
      skipped += Math.max(0, Math.floor((now - next) / 50))
      next = now + 50
      ticks++
      write('\x1b[H' + Array.from({ length: 8 }, (_, row) =>
        `\x1b[${row % 2 ? 36 : 32}mRESOURCE ${index} FRAME ${ticks} ROW ${row}  deterministic output\x1b[0m\x1b[K\r\n`).join(''))
    }, 50)
  }
}
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', value => write(value.toString()))
write(Array.from({ length: 1000 }, (_, row) => `${row}  resource fixture ${index} retained terminal output\r\n`).join(''))
write(`RESOURCE ${index} READY\r\n`)
createServer(socket => {
  let input = ''
  socket.on('data', chunk => {
    input += chunk
    assert(input.length < 4096, 'Oversized fixture command')
    const end = input.indexOf('\n')
    if (end < 0) return
    try {
      const command = JSON.parse(input.slice(0, end))
      if (command.mode) setMode(command.mode)
      socket.end(JSON.stringify({ success: true, ...state() }) + '\n')
    } catch (error) { socket.end(JSON.stringify({ success: false, error: String(error) }) + '\n') }
  })
}).listen(join(root, `worker-${index}.sock`))
