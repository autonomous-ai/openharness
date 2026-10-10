import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

/** Pi and OpenCode register through generated source, so pin its process-owned wire contract directly. */
const dirs: string[] = []
const version = vi.hoisted(() => ({ major: 1 as number | null, read: undefined as undefined | (() => number | null | Promise<number | null>) }))
vi.mock('../engines/launchControl.js', () => ({ opencodeMajorVersion: () => version.read ? version.read() : version.major }))
beforeEach(() => {
  version.major = 1
  version.read = undefined
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-discovery-'))
  dirs.push(dir)
  return dir
}

describe('generated discovery scripts', () => {
  it('does not let an obsolete version probe undo a newer plugin installation', async () => {
    const config = scratch(), pluginDir = join(config, 'plugin')
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    let finish!: (major: null) => void
    version.read = () => new Promise<null>(done => { finish = done })
    const obsolete = installOpencodePlugin(4242)
    version.read = () => 1
    await installOpencodePlugin(4242)
    const file = join(pluginDir, 'launcher-register.js'), confirmed = readFileSync(file, 'utf8')
    finish(null)
    await obsolete
    expect(readFileSync(file, 'utf8')).toBe(confirmed)
  })

  it('bounds a superseded install waiting for its current sibling and refuses a changed port', async () => {
    const config = scratch(), pluginDir = join(config, 'plugin')
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    const { OPENCODE_VERSION } = await import('../engines/opencode/contract.js')
    const finishes: Array<(major: number) => void> = []
    version.read = () => new Promise<number>(done => { finishes.push(done) })
    const older = installOpencodePlugin(4242), newer = installOpencodePlugin(4242)
    finishes[0]!(1)
    await vi.advanceTimersByTimeAsync(OPENCODE_VERSION.timeoutMs)
    expect(await older).toBe(false)
    expect(existsSync(join(pluginDir, 'launcher-register.js'))).toBe(false)
    finishes[1]!(1)
    expect(await newer).toBe(true)
    const oldPort = installOpencodePlugin(4242), newPort = installOpencodePlugin(4243)
    finishes[2]!(1); finishes[3]!(1)
    expect(await oldPort).toBe(false)
    expect(await newPort).toBe(true)
  })

  it('lets the Pi extension post from any terminal context without launcher metadata', async () => {
    const piHome = scratch()
    vi.resetModules()
    vi.stubEnv('PI_HOME', piHome)
    const { installPiExtension } = await import('./hooks.js')
    installPiExtension(18473)

    const src = readFileSync(join(piHome, 'agent', 'extensions', 'launcher-register.ts'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).not.toContain('HERDR')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
  })

  it('lets the OpenCode plugin post from any terminal context without launcher metadata', async () => {
    const pluginDir = join(scratch(), 'plugin')
    vi.resetModules()
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    await installOpencodePlugin(18473)

    const src = readFileSync(join(pluginDir, 'launcher-register.js'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).not.toContain('HERDR')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
    expect(src).toContain('if (!pane || !token')
  })

  // OpenCode 2.0 loads only `export default { id, setup }`, runs server plugins in one shared service
  // (no TMUX_PANE there), and scans `plugins/<dir>/tui.js` for plugins that run IN the pane's TUI. So
  // 2.0 gets a TUI plugin posting the same session-start the 1.x plugin posts, for the session the
  // pane shows. The legacy file must be absent: 2.0 also discovers it, then refuses its old API.
  it('installs only the compatible OpenCode 2 plugin, posting the session the pane shows', async () => {
    const config = scratch()
    const data = scratch()
    const pluginDir = join(config, 'plugin')
    vi.resetModules()
    version.major = 2
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    vi.stubEnv('ADAPTER_DATA_DIR', data)
    writeFileSync(join(data, 'hook-credential'), 'tok-123\n')
    const { installOpencodePlugin } = await import('./hooks.js')
    await installOpencodePlugin(18473)

    expect(existsSync(join(pluginDir, 'launcher-register.js'))).toBe(false)
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

  it('migrates a running daemon from OpenCode 1 to 2 idempotently and can restore 1.x hooks', async () => {
    const config = scratch()
    const pluginDir = join(config, 'plugin')
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    const legacy = join(pluginDir, 'launcher-register.js')
    const tui = join(config, 'plugins', 'launcher-register', 'tui.js')
    await installOpencodePlugin(18473)
    const original = readFileSync(legacy, 'utf8')
    expect(original).toContain('export const MachineRegister')
    const before = statSync(tui).mtimeMs
    version.major = 2
    await installOpencodePlugin(18473)
    await installOpencodePlugin(18473)
    expect(existsSync(legacy)).toBe(false)
    expect(statSync(tui).mtimeMs).toBe(before)
    version.major = 1
    await installOpencodePlugin(18473)
    expect(readFileSync(legacy, 'utf8')).toBe(original)
  })

  it.each([2, null])('preserves foreign files and model settings for OpenCode major %s', async (major) => {
    const config = scratch()
    const pluginDir = join(config, 'plugin')
    mkdirSync(pluginDir)
    const legacy = join(pluginDir, 'launcher-register.js')
    const foreign = '// user plugin\nexport default { id: "user", setup() {} }\n'
    writeFileSync(legacy, foreign)
    const settings = join(config, 'opencode.json')
    const settingsText = '{"model":"user/provider-model"}\n'
    writeFileSync(settings, settingsText)
    version.major = major
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    await installOpencodePlugin(18473)
    expect(readFileSync(legacy, 'utf8')).toBe(foreign)
    expect(readFileSync(settings, 'utf8')).toBe(settingsText)
  })

  it('does not plant a v1 plugin before the pane installs OpenCode for the first time', async () => {
    const config = scratch()
    const pluginDir = join(config, 'plugin')
    version.major = null
    vi.stubEnv('OPENCODE_PLUGIN_DIR', pluginDir)
    const { installOpencodePlugin } = await import('./hooks.js')
    await installOpencodePlugin(18473)
    expect(existsSync(join(pluginDir, 'launcher-register.js'))).toBe(false)
    expect(existsSync(join(config, 'plugins', 'launcher-register', 'tui.js'))).toBe(true)
  })
})
