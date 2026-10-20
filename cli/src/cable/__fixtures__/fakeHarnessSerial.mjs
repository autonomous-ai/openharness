// A stand-in for harness-serial.exe (serial/), speaking its stdio contract
// (docs/superpowers/specs/2026-10-19-windows-dial-design.md §1), so cable/windowsSerial.ts is tested on any OS.
// Run as `node fakeHarnessSerial.mjs <watch | open COMn | probe COMn>`; the environment picks its behaviour:
//   FAKE_SERIAL_LINES  watch: a JSON array of lines to print, 20 ms apart
//   FAKE_SERIAL_SPLIT  watch: print each line in two writes, 30 ms apart
//   FAKE_SERIAL_EXIT   watch: after the lines, say `error: enumeration failed` and exit with this code
//   FAKE_SERIAL_DELAY  watch: wait this many ms before printing its lines
//   FAKE_SERIAL_STUBBORN watch: ignore stdin EOF, to test bounded cleanup
//   FAKE_SERIAL_OPEN   open: echo (default) | busy | gone | silent | partial | stubborn | stubborn-open | unplug:<ms>
//   FAKE_SERIAL_PROBE  probe: free (default) | busy | gone
// Every write that is followed by an exit waits for its callback: on a pipe a write can still be in flight.
const [mode] = process.argv.slice(2)
const env = process.env
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve))
const exitAtEndOfStdin = () => { process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)) }

if (mode === 'watch') {
  if (env.FAKE_SERIAL_STUBBORN) { process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
  else exitAtEndOfStdin()
  await sleep(Number(env.FAKE_SERIAL_DELAY ?? 0))
  for (const line of JSON.parse(env.FAKE_SERIAL_LINES ?? '[]')) {
    if (env.FAKE_SERIAL_SPLIT) {
      const half = Math.floor(line.length / 2)
      await write(process.stdout, line.slice(0, half))
      await sleep(30)
      await write(process.stdout, `${line.slice(half)}\n`)
    } else {
      await write(process.stdout, `${line}\n`)
    }
    await sleep(20)
  }
  if (env.FAKE_SERIAL_EXIT) {
    await write(process.stderr, 'error: enumeration failed\n')
    process.exit(Number(env.FAKE_SERIAL_EXIT))
  }
} else if (mode === 'open') {
  const behaviour = env.FAKE_SERIAL_OPEN ?? 'echo'
  if (behaviour === 'busy') { await write(process.stderr, 'busy\n'); process.exit(3) }
  if (behaviour === 'gone') { await write(process.stderr, 'gone\n'); process.exit(4) }
  if (behaviour === 'stubborn') { process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
  else if (behaviour === 'silent') exitAtEndOfStdin()
  else {
    if (behaviour === 'partial') { await write(process.stderr, 'open'); exitAtEndOfStdin() }
    else await write(process.stderr, 'open\n')
    process.stdin.on('data', (chunk) => process.stdout.write(chunk))
    if (behaviour === 'stubborn-open') {
      process.on('SIGTERM', () => {})
      // A signal listener alone lets Node exit naturally after stdin EOF, hiding a missing kill deadline.
      setInterval(() => {}, 1000)
    }
    else process.stdin.on('end', () => process.exit(0))
    if (behaviour.startsWith('unplug:')) {
      await sleep(Number(behaviour.slice('unplug:'.length)))
      await write(process.stderr, 'closed: The device is not connected.\n')
      process.exit(5)
    }
  }
} else if (mode === 'probe') {
  process.exit({ busy: 3, gone: 4 }[env.FAKE_SERIAL_PROBE] ?? 0)
} else {
  await write(process.stderr, 'usage: harness-serial watch | open COMn | probe COMn | version\n')
  process.exit(2)
}
