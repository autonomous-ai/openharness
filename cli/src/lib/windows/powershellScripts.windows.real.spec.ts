// The read-only scripts the CLI runs on Windows, run as the CLI runs them: Windows PowerShell 5.1 from System32, with the
// prelude and autoload off. powershellModules.spec.ts reads their text; only Windows says a command is "not recognized"
// when its module is not imported. Windows only; the Windows workflow runs it with src/lib/windows. The scripts that change
// the computer (guest sharing's install and processor, the team removal, the uninstall's PATH write) are read as text alone.
import { createServer, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { windowsListenerQuery } from '../peerAccount.js'
import { windowsProcessQuery } from '../signOut.js'
import { runPowershellAsync } from './powershell.js'
import { SCRIPT as STORE_PACKAGE_SCRIPT } from './storePackage.js'

const WINDOWS = process.platform === 'win32'
const NOT_RECOGNIZED = /is not recognized/i
/** A runner's first Windows PowerShell can take tens of seconds to start (docs/windows-rules.md). */
const RUN_MS = 60_000

describe.runIf(WINDOWS)('the read-only PowerShell scripts, run by Windows PowerShell', () => {
  it("signOut's process query names this process's parent", async () => {
    const result = await runPowershellAsync(windowsProcessQuery(process.pid), {}, RUN_MS)
    expect(result.stderr).not.toMatch(NOT_RECOGNIZED)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ParentProcessId: process.ppid })
  }, RUN_MS * 2)

  it("the listener query says this account holds a port this process listens on", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const query = windowsListenerQuery((server.address() as AddressInfo).port)
      const result = await runPowershellAsync(query.script, query.inputs, RUN_MS)
      expect(result.stderr).not.toMatch(NOT_RECOGNIZED)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('yes')
    } finally {
      server.close()
    }
  }, RUN_MS * 2)

  // A runner's account may have no Store packages, or no package service: its answer is the folder, nothing, or a
  // failure the CLI reads as none. Every command it calls is found.
  it('the Store package query finds every command it calls', async () => {
    const result = await runPowershellAsync(STORE_PACKAGE_SCRIPT, { HARNESS_STORE_PACKAGE: 'OpenAI.Codex' }, RUN_MS)
    expect(result.stderr).not.toMatch(NOT_RECOGNIZED)
  }, RUN_MS * 2)
})
