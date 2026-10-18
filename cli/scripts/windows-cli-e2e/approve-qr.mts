// npx tsx scripts/windows-cli-e2e/approve-qr.mts <user@host>: sign the Windows user in to the account this Mac is
// signed in to. It runs `harness login --qr --json` there over SSH, approves the QR's code with this Mac's session (any
// signed-in session may), and answers the sign-in's confirmation. Prints every event, then the machine id the sign-in
// registered on the account: the run's cleanup removes it from the Mac (`harness machines delete <id> --yes`).
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { controlPlaneAuth, postJson } from '../../src/lib/controlPlane.js'

const destination = process.argv[2]
if (!destination) { console.error('usage: approve-qr.mts <user@host>'); process.exit(2) }
const child = spawn('ssh', ['-o', 'BatchMode=yes', destination, 'harness login --qr --json'], { stdio: ['pipe', 'pipe', 'inherit'] })
let result: Record<string, unknown> | null = null
try {
  for await (const text of createInterface({ input: child.stdout! })) {
    console.log(text)
    let event: Record<string, unknown>
    try { event = JSON.parse(text) } catch { continue }
    if (event.type === 'qr' && typeof event.url === 'string') {
      const code = decodeURIComponent(new URL(event.url).hash.replace(/^#k=/, ''))
      const { headers } = await controlPlaneAuth()
      console.log(`approved: ${JSON.stringify(await postJson('/api/auth/qr/approve', { code }, headers))}`)
    }
    if (event.type === 'confirm') child.stdin!.write('yes\n')
    if (event.type === 'result') { result = event; break }
  }
} finally {
  child.stdin!.end()
  // In a finally, so a failed approval or a dropped connection still says what to clean up: an approved code can have
  // registered a machine on the account even when the sign-in did not finish.
  const ok = result?.status === 'ok' || result?.status === 'success'
  const id = machineIdOn(destination)
  if (ok && id) console.log(`machine registered: ${id}; remove it after the run: harness machines delete ${id} --yes`)
  else console.log(`the sign-in ${ok ? 'finished' : `did not finish (${String(result?.status ?? 'no result')})`}${id ? `; ${destination} names machine ${id}` : ''}: check \`harness machines\` for a machine this run registered, and remove it with harness machines delete <id> --yes`)
  process.exitCode = ok ? 0 : 1
}

/** The machine id in the Windows user's session.json, or '' when it cannot be read. Best effort: it never throws. */
function machineIdOn(where: string): string {
  // Only the machine id leaves session.json, never its tokens. PowerShell by -EncodedCommand keeps the VM's cmd shell
  // out of the quoting.
  const ps = "(Get-Content -Raw (Join-Path $env:USERPROFILE '.harness\\auth\\session.json') | ConvertFrom-Json).machineId"
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  try {
    return execFileSync('ssh', ['-o', 'BatchMode=yes', where, `powershell -NoProfile -EncodedCommand ${encoded}`], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
