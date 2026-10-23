// The data folder claim on real Windows named pipes, across processes: a second core's claim on the same folder is
// refused, one on another folder is not. Windows only:
//   cd cli && npx vitest run src/lib/windows/dataFolderClaim.real.spec.ts
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { claimDataFolder, dataFolderClaimPipe } from './dataFolderClaim.js'

const TOKEN = Buffer.alloc(32, 7)

const scratch = mkdtempSync(join(tmpdir(), 'hclaim-real-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cli = fileURLToPath(new URL('../../..', import.meta.url))

/** Another process claims [dataDir] and says what it got. */
function claimElsewhere(dataDir: string): Promise<string> {
  const script = join(scratch, `claim-${Math.random().toString(16).slice(2)}.mts`)
  writeFileSync(script, `import { claimDataFolder } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./dataFolderClaim.ts', import.meta.url))).href)}
try { const claim = await claimDataFolder(${JSON.stringify(dataDir)}, Buffer.alloc(32, 7), { askTimeoutMs: 2000 }); console.log((claim.held ? 'claimed ' : 'unheld ') + claim.path); claim.release() }
catch (error) { console.log('refused ' + error.code + ' ' + error.message) }
`)
  return new Promise((resolve, reject) => execFile(process.execPath, ['--import', 'tsx', script], { cwd: cli, timeout: 60_000 },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim())))
}

;(process.platform === 'win32' ? describe : describe.skip)('the data folder claim on real pipes', () => {
  it('refuses a second process on the same folder, lets one on another folder through, and frees the folder on release', async () => {
    const a = join(scratch, 'a'), b = join(scratch, 'b')
    const held = await claimDataFolder(a, TOKEN)
    expect(held.path).toMatch(/^\\\\\.\\pipe\\harness-claim-[0-9a-f]{32}$/)
    expect(await claimElsewhere(a)).toBe(`refused EADDRINUSE A Harness daemon is already serving ${a}`)
    expect(await claimElsewhere(a.toUpperCase())).toMatch(/^refused EADDRINUSE /)
    expect(await claimElsewhere(b)).toMatch(/^claimed \\\\\.\\pipe\\harness-claim-[0-9a-f]{32}$/)
    held.release()
    expect(await claimElsewhere(a)).toBe(`claimed ${held.path}`)
  }, 120_000)

  it('starts without the claim when another process that is not Harness holds its name', async () => {
    const c = join(scratch, 'c')
    mkdirSync(c, { recursive: true })
    const name = dataFolderClaimPipe(realpathSync.native(c))
    const squatter = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => squatter.listen(name, () => resolve()))
    try {
      // The start logs why, then goes on: the log line first, as the core writes it to its log.
      expect((await claimElsewhere(c)).split(/\r?\n/)).toEqual([`[cli] something that is not Harness holds ${name}; starting without the data folder claim`, `unheld ${name}`])
    } finally {
      squatter.close()
    }
  }, 120_000)
})
