import { describe, expect, it } from 'vitest'
import type { PowershellResult } from './powershell.js'
import { STORE_PACKAGE_ASK_MS, STORE_PACKAGE_TIMEOUT_MS, storePackageFolder, storePackageLook } from './storePackage.js'

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

describe('storePackageLook', () => {
  /** A look at package OpenAI.Codex whose query waits for the test to answer it, on a clock and a disk the test sets. */
  function look() {
    const asked: string[] = []
    const answers: Array<(folder: string | null) => void> = []
    const fails: Array<() => void> = []
    const disk = new Set<string>()
    const clock = { at: 0 }
    const query = (name: string) => {
      asked.push(name)
      return new Promise<string | null>((resolve, reject) => {
        answers.push(resolve)
        fails.push(() => reject(new Error('no PowerShell')))
      })
    }
    const store = storePackageLook('OpenAI.Codex', query, () => clock.at, (path) => disk.has(path))
    return { asked, answers, fails, disk, clock, store }
  }

  it('a found folder is answered by known() and ask() with no second query while it is there, and asked for at once when it is gone', async () => {
    const { asked, answers, disk, clock, store } = look()
    disk.add(FOLDER)
    const first = store.ask()
    expect(asked).toEqual(['OpenAI.Codex'])
    answers[0]!(FOLDER)
    expect(await first).toBe(FOLDER)
    expect(store.known()).toBe(FOLDER)
    clock.at += STORE_PACKAGE_ASK_MS * 3
    expect(await store.ask()).toBe(FOLDER)
    expect(asked).toHaveLength(1)

    // An update moves the package to a folder named for its new version.
    disk.delete(FOLDER)
    expect(store.known()).toBeNull()
    const updated = FOLDER.replace('26.1117.3838.0', '26.1201.1000.0')
    disk.add(updated)
    const again = store.ask()
    expect(asked).toHaveLength(2)
    answers[1]!(updated)
    expect(await again).toBe(updated)
    expect(store.known()).toBe(updated)
  })

  it('not installed and a query that throws answer null, and are asked again only after 10 minutes', async () => {
    const { asked, answers, fails, clock, store } = look()
    expect(STORE_PACKAGE_ASK_MS).toBe(600_000)
    const missed = store.ask()
    answers[0]!(null)
    expect(await missed).toBeNull()
    clock.at += 599_999
    expect(await store.ask()).toBeNull()
    expect(asked).toHaveLength(1)
    clock.at += 1
    const failed = store.ask()
    expect(asked).toHaveLength(2)
    fails[1]!()
    expect(await failed).toBeNull()
    expect(store.known()).toBeNull()
    clock.at += 599_999
    expect(await store.ask()).toBeNull()
    expect(asked).toHaveLength(2)
    clock.at += 1
    void store.ask()
    expect(asked).toHaveLength(3)
  })

  it('two asks during one query share it', async () => {
    const { asked, answers, disk, store } = look()
    disk.add(FOLDER)
    const one = store.ask()
    const two = store.ask()
    expect(asked).toHaveLength(1)
    answers[0]!(FOLDER)
    expect(await Promise.all([one, two])).toEqual([FOLDER, FOLDER])
  })

  it('known() never queries', async () => {
    const { asked, answers, store } = look()
    expect(store.known()).toBeNull()
    expect(asked).toEqual([])
    const missed = store.ask()
    answers[0]!(null)
    await missed
    expect(store.known()).toBeNull()
    expect(asked).toHaveLength(1)
  })
})
