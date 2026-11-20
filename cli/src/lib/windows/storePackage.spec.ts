import { describe, expect, it } from 'vitest'
import type { PowershellResult } from './powershell.js'
import { STORE_PACKAGE_TIMEOUT_MS, storePackageFolder } from './storePackage.js'

const FOLDER = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.3838.0_arm64__2p2nqsd0c76g0'

/** A PowerShell that answers [result], recording what it was asked. */
function powershell(result: Partial<PowershellResult>) {
  const asked: Array<{ script: string; inputs: Record<string, string>; timeoutMs: number | undefined }> = []
  const run = async (script: string, inputs: Record<string, string> = {}, timeoutMs?: number): Promise<PowershellResult> => {
    asked.push({ script, inputs, timeoutMs })
    return { status: 0, stdout: '', stderr: '', ...result }
  }
  return { asked, run }
}

describe('storePackageFolder', () => {
  it('asks Get-AppxPackage for the package named in an input, never in the script, for 10 s, and answers its InstallLocation', async () => {
    const { asked, run } = powershell({ stdout: `${FOLDER}\r\n` })
    expect(await storePackageFolder('OpenAI.Codex', run)).toBe(FOLDER)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.script).toContain('Get-AppxPackage')
    expect(asked[0]!.script).toContain('InstallLocation')
    expect(asked[0]!.script).not.toContain('OpenAI.Codex')
    expect(Object.values(asked[0]!.inputs)).toEqual(['OpenAI.Codex'])
    expect(asked[0]!.timeoutMs).toBe(10_000)
    expect(STORE_PACKAGE_TIMEOUT_MS).toBe(10_000)
  })

  it('no package, a failed or timed-out query, and an answer that is not one absolute folder are null', async () => {
    for (const result of [
      { stdout: '' },
      { stdout: '\r\n' },
      { status: 1, stderr: 'not found' },
      { status: null },
      { stdout: 'WindowsApps\\OpenAI.Codex' },
      { stdout: `${FOLDER}\r\n${FOLDER}\r\n` },
      { stdout: `${FOLDER}\0` },
    ]) {
      expect(await storePackageFolder('OpenAI.Codex', powershell(result).run), JSON.stringify(result)).toBeNull()
    }
  })

  it('a name that is not a package name asks nothing', async () => {
    for (const name of ['', 'OpenAI.*', 'a b', "x'; calc", 'a'.repeat(51)]) {
      const { asked, run } = powershell({ stdout: FOLDER })
      expect(await storePackageFolder(name, run), name).toBeNull()
      expect(asked, name).toEqual([])
    }
  })
})
