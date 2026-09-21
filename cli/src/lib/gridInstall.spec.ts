import { describe, expect, it, vi } from 'vitest'
import { ensureGridInstalled, GRID_INSTALL_URL, type GridInstallDeps } from './gridInstall.js'

function deps(overrides: Partial<GridInstallDeps> = {}): GridInstallDeps & { runs: string[] } {
  const runs: string[] = []
  return {
    runs,
    available: () => false,
    curlOnPath: () => true,
    enabled: true,
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
})
