import { describe, expect, it, vi } from 'vitest'
import { ensureGridInstalled, GRID_INSTALL_PS1_URL, GRID_INSTALL_URL, installerCommand, installGrid, windowsInstallScript, type GridInstallDeps } from './gridInstall.js'

function deps(overrides: Partial<GridInstallDeps> = {}): GridInstallDeps & { runs: string[] } {
  const runs: string[] = []
  return {
    runs,
    available: () => false,
    curlOnPath: () => true,
    enabled: true,
    // The curl-and-bash path, whatever machine runs the test; the Windows tests say 'win32'.
    platform: 'linux',
    run: async (script) => { runs.push(script); return { exitCode: 0, output: '✓ grid installed' } },
    ...overrides,
  }
}

describe('ensureGridInstalled', () => {
  it('runs nothing on a machine that already has grid', async () => {
    const d = deps({ available: () => true })
    expect(await ensureGridInstalled(d)).toMatchObject({ status: 'present' })
    expect(d.runs).toEqual([])
  })

  it("pipes grid's own public installer to bash, and reports installed once grid resolves", async () => {
    let installed = false
    const runs: string[] = []
    const d = deps({
      available: () => installed,
      run: async (script) => { runs.push(script); installed = true; return { exitCode: 0, output: 'ok' } },
    })
    const result = await ensureGridInstalled(d)
    expect(result.status).toBe('installed')
    expect(runs).toEqual([`curl -fsSL ${GRID_INSTALL_URL} | bash`])
  })

  it('is skipped, not failed, when switched off or when there is no curl', async () => {
    expect((await ensureGridInstalled(deps({ enabled: false }))).status).toBe('skipped')
    const noCurl = deps({ curlOnPath: () => false })
    expect((await ensureGridInstalled(noCurl)).status).toBe('skipped')
    expect(noCurl.runs).toEqual([])
  })

  it('reports a failed installer with its last lines, colour stripped', async () => {
    const d = deps({ run: async () => ({ exitCode: 1, output: 'downloading\n[1;31mERROR:[0m no release' }) })
    const result = await ensureGridInstalled(d)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('exited 1')
    expect(result.message).toContain('ERROR: no release')
    expect(result.message).not.toContain('')
  })

  it('reports failure when the installer succeeds but grid is still not resolvable', async () => {
    const d = deps({ run: async () => ({ exitCode: 0, output: 'done' }) })
    const result = await ensureGridInstalled(d)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('left no `grid`')
  })

  it('shares one in-flight install between concurrent callers', async () => {
    let installed = false
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      installed = true
      return { exitCode: 0, output: '' }
    })
    const d = deps({ available: () => installed, run })
    const [a, b] = await Promise.all([ensureGridInstalled(d), ensureGridInstalled(d)])
    expect(a.status).toBe('installed')
    expect(b.status).toBe('installed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("on Windows runs grid's PowerShell installer, and does not need curl", async () => {
    let installed = false
    const runs: string[] = []
    const d = deps({
      platform: 'win32',
      curlOnPath: () => false,
      available: () => installed,
      run: async (script) => { runs.push(script); installed = true; return { exitCode: 0, output: 'ok' } },
    })
    expect((await ensureGridInstalled(d)).status).toBe('installed')
    expect(runs).toEqual([windowsInstallScript(null)])
  })
})

describe('windowsInstallScript', () => {
  it("runs grid's install.ps1, and prints only the sentence it fails with — not PowerShell's error record around it", () => {
    expect(windowsInstallScript(null)).toBe(
      `try { irm ${GRID_INSTALL_PS1_URL} | iex } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`)
  })

  it('tells it which release to lay down', () => {
    expect(windowsInstallScript('0.3.62')).toBe(
      `try { $env:GRID_VERSION='0.3.62'; irm ${GRID_INSTALL_PS1_URL} | iex } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`)
  })
})

describe('installGrid', () => {
  it('tells the Windows installer which release to lay down, over the grid already there', async () => {
    const runs: string[] = []
    const d = deps({
      platform: 'win32',
      available: () => true,
      run: async (script) => { runs.push(script); return { exitCode: 0, output: 'ok' } },
    })
    expect((await installGrid('0.3.62', d)).status).toBe('installed')
    expect(runs).toEqual([windowsInstallScript('0.3.62')])
  })

  it('on Windows runs the installer with no grid call of this process running (gridCalls.ts)', async () => {
    const order: string[] = []
    const pause = async <T>(install: () => Promise<T>): Promise<T> => { order.push('pause'); const r = await install(); order.push('resume'); return r }
    const run = async () => { order.push('run'); return { exitCode: 0, output: '' } }
    await installGrid('0.3.62', deps({ platform: 'win32', available: () => true, pause, run }))
    expect(order).toEqual(['pause', 'run', 'resume'])
    order.length = 0
    await installGrid(null, deps({ available: () => true, pause, run }))
    expect(order).toEqual(['run'])
  })

  it("logs Windows' last lines without their carriage returns", async () => {
    const output = '>>> Resolving grid wheel (0.3.60 -> v0.3.60)...\r\nERROR: grid is running from this install (pid 9044).\r\n'
    const result = await installGrid('0.3.60', deps({ platform: 'win32', run: async () => ({ exitCode: 1, output }) }))
    expect(result.message).toBe('grid installer exited 1 · >>> Resolving grid wheel (0.3.60 -> v0.3.60)... · ERROR: grid is running from this install (pid 9044).')
  })

  it('refuses a version that is not a plain release number — it goes into a PowerShell line', async () => {
    const d = deps({ platform: 'win32' })
    expect((await installGrid("1'; Remove-Item ~ -Recurse; '", d)).status).toBe('skipped')
    expect(d.runs).toEqual([])
  })
})

describe('installerCommand', () => {
  it('runs the installer script with bash off Windows', () => {
    expect(installerCommand('darwin', 'S')).toEqual({ file: 'bash', args: ['-c', 'S'] })
    expect(installerCommand('linux', 'S')).toEqual({ file: 'bash', args: ['-c', 'S'] })
  })

  it("runs it with Windows PowerShell by absolute path on Windows — a bare name is searched in the current folder", () => {
    expect(installerCommand('win32', 'S', { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'S'],
    })
  })
})
