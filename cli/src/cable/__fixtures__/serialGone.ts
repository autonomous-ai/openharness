// Paired with serialGone.py: only that driver's disposable PTY is opened.
import { SerialLink } from '../serial.js'

const [path, mode] = process.argv.slice(2)
const timeout = setTimeout(() => { console.log(JSON.stringify({ mode, hung: true })); process.exit(1) }, 5_000)
const started = Date.now()
try {
  const received: Buffer[] = []
  const link = await SerialLink.open(path, (chunk) => { received.push(chunk) }, () => {})
  // What the dial sent before the port was opened arrives first, and nothing is lost after it.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await link.close('done')
  console.log(JSON.stringify({ mode, opened: true, received: Buffer.concat(received).toString('utf8') }))
} catch (error) {
  console.log(JSON.stringify({ mode, opened: false, code: (error as NodeJS.ErrnoException).code ?? null, ms: Date.now() - started }))
}
clearTimeout(timeout)
