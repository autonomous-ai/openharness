// Paired with serialGone.py: only that driver's disposable PTY is opened.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { SerialLink } from '../serial.js'

const [path, mode] = process.argv.slice(2)
// `raced`: the far end goes just after the probe read, which is told "nothing yet" here, as it was then.
if (mode === 'raced') {
  fs.readSync = (() => { throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) }) as typeof fs.readSync
  syncBuiltinESMExports()
}
const timeout = setTimeout(() => { console.log(JSON.stringify({ mode, hung: true })); process.exit(1) }, 5_000)
const started = Date.now()
try {
  const received: Buffer[] = []
  let closed: string | null = null
  const link = await SerialLink.open(path, (chunk) => { received.push(chunk) }, (why) => { closed ??= why })
  const openMs = Date.now() - started
  // What the dial sent before the port was opened arrives first, and nothing is lost after it.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await link.close('done')
  console.log(JSON.stringify({ mode, opened: true, received: Buffer.concat(received).toString('utf8'), closed, openMs }))
} catch (error) {
  console.log(JSON.stringify({ mode, opened: false, code: (error as NodeJS.ErrnoException).code ?? null, ms: Date.now() - started }))
}
clearTimeout(timeout)
