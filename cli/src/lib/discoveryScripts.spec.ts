import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

/** Pi and OpenCode register through generated source, so pin its process-owned wire contract directly. */
const dirs: string[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-discovery-'))
  dirs.push(dir)
  return dir
}

describe('generated discovery scripts', () => {
  it('lets the Pi extension post from any terminal context without launcher metadata', async () => {
    const piHome = scratch()
    vi.resetModules()
    process.env.PI_HOME = piHome
    const { installPiExtension } = await import('./hooks.js')
    installPiExtension(18473)

    const src = readFileSync(join(piHome, 'agent', 'extensions', 'launcher-register.ts'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).not.toContain('HERDR')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
  })

  it('lets the OpenCode plugin post from any terminal context without launcher metadata', async () => {
    const pluginDir = scratch()
    vi.resetModules()
    process.env.OPENCODE_PLUGIN_DIR = pluginDir
    const { installOpencodePlugin } = await import('./hooks.js')
    installOpencodePlugin(18473)

    const src = readFileSync(join(pluginDir, 'launcher-register.js'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).not.toContain('HERDR')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
    expect(src).toContain('if (!pane || !token')
  })

  // OpenCode 2.0 loads only `export default { id, setup }`, runs server plugins in one shared service
  // (no TMUX_PANE there), and scans `plugins/<dir>/tui.js` for plugins that run IN the pane's TUI. So
  // 2.0 gets a TUI plugin beside the 1.x file — which is left exactly as it was — posting the same
  // session-start the 1.x plugin posts, for the session the pane shows.
  it('adds an OpenCode 2.0 TUI plugin that posts the session the pane shows, and leaves the 1.x file as it was', async () => {
    const config = scratch()
    const data = scratch()
    const pluginDir = join(config, 'plugin')
    vi.resetModules()
    process.env.OPENCODE_PLUGIN_DIR = pluginDir
    process.env.ADAPTER_DATA_DIR = data
    writeFileSync(join(data, 'hook-credential'), 'tok-123\n')
    const { installOpencodePlugin } = await import('./hooks.js')
    installOpencodePlugin(18473)

    const v1 = readFileSync(join(pluginDir, 'launcher-register.js'), 'utf-8')
    expect(v1).toContain('export const MachineRegister')
    expect(v1).not.toContain('export default')
    const tuiPath = join(config, 'plugins', 'launcher-register', 'tui.js')
    expect(existsSync(tuiPath)).toBe(true)

    const posts: Array<{ url: string; body: Record<string, unknown>; token: string }> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)), token: String((init?.headers as Record<string, string>)['x-harness-hook-token']) })
      return new Response(null, { status: 204 })
    })
    const pane = process.env.TMUX_PANE
    process.env.TMUX_PANE = '%60'
    try {
      const plugin = (await import(pathToFileURL(tuiPath).href)).default
      expect(plugin.id).toBeTruthy()
      let route: { type: string; sessionID?: string } = { type: 'home' }
      const sessions: Record<string, { parentID?: string; location: { directory: string } }> = {
        ses_main: { location: { directory: '/w/app' } },
        ses_child: { parentID: 'ses_main', location: { directory: '/w/app' } },
        ses_next: { location: { directory: '/w/app' } },
      }
      const ctx = { ui: { router: { current: () => route } }, data: { session: { get: (id: string) => sessions[id] }, on: () => () => {} } }
      const stop = plugin.setup(ctx)
      const tick = () => vi.advanceTimersByTimeAsync(1_100)
      route = { type: 'session', sessionID: 'ses_main' }
      await tick(); await tick()
      route = { type: 'session', sessionID: 'ses_child' }
      await tick()
      route = { type: 'session', sessionID: 'ses_next' }
      await tick()
      if (typeof stop === 'function') stop()
      expect(posts.map((p) => p.body.sessionId)).toEqual(['ses_main', 'ses_next'])
      expect(posts[0]).toMatchObject({ url: 'http://127.0.0.1:18473/api/hook/session-start', token: 'tok-123' })
      expect(posts[0].body).toMatchObject({ engine: 'opencode', sessionId: 'ses_main', tmuxPane: '%60', cwd: '/w/app', callerPid: process.pid })
    } finally {
      fetchSpy.mockRestore()
      if (pane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = pane
    }
  })
})
