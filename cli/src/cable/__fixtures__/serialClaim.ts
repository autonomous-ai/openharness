import assert from 'node:assert/strict'
import { SerialLink } from '../serial.js'

const [path] = process.argv.slice(2)
const deadline = setTimeout(() => { console.error('Serial claim timed out'); process.exit(1) }, 8000)
try {
  const link = await SerialLink.open(path, () => {}, () => {})
  process.stdout.write('claimed\n')
  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
  await link.close()
  process.stdout.write('released\n')
} catch (error) {
  assert.equal((error as NodeJS.ErrnoException).code, 'EAGAIN')
  process.stdout.write('busy\n')
} finally { clearTimeout(deadline); process.stdin.destroy() }
