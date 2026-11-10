import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserTools } from '../../lib/browserToolsAsset.js'
import { browserAssetsHash, browserContextFiles, PLAYWRIGHT_CORE_VERSION } from './assets.js'

const folder = new URL('../../../assets/browser/', import.meta.url)
const onDisk = (name: string) => readFileSync(new URL(name, folder), 'utf8')
// `*.d.mts` files type the scripts for the CLI's own imports; the image never needs them.
const assetNames = () => readdirSync(folder).filter(name => !name.endsWith('.d.mts')).sort()

afterEach(() => { vi.unstubAllGlobals() })

describe('browser assets', () => {
  it('embedded copies equal the files', () => {
    const files = browserContextFiles()
    expect(Object.keys(files).sort()).toEqual(assetNames())
    for (const name of assetNames()) expect(files[name], name).toBe(onDisk(name))
    // The release bundle carries each file through a define in both builds, read from the same file.
    for (const build of ['../../../build-bundle.mjs', '../../../build.mjs']) {
      const source = readFileSync(new URL(build, import.meta.url), 'utf8')
      for (const name of assetNames()) expect(source, `${build} ${name}`).toContain(`readFileSync('assets/browser/${name}', 'utf8')`)
    }
  })

  it('the bundle\'s copies win over the files', () => {
    const names = ['CONTAINERFILE', 'ENTRYPOINT', 'POLICY', 'TOOLS_JSON', 'TOOLS', 'TOOLS_LIB', 'SOCKS5', 'HUMAN_INPUT', 'CHALLENGE', 'PROXY_RELAY', 'DEVICE_INJECT']
    for (const name of names) vi.stubGlobal(`__BROWSER_${name}__`, `bundled ${name}`)
    expect(Object.values(browserContextFiles()).sort()).toEqual(names.map(name => `bundled ${name}`).sort())
  })

  it('hash covers every file, names included', () => {
    const files = browserContextFiles()
    const hash = createHash('sha256')
    for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`)
    const before = browserAssetsHash()
    expect(before).toBe(hash.digest('hex').slice(0, 12))
    vi.stubGlobal('__BROWSER_POLICY__', '{}')
    expect(browserAssetsHash()).not.toBe(before)
  })

  it('containerfile pins what the spec names', () => {
    const file = onDisk('Containerfile')
    expect(file).toMatch(/^FROM docker\.io\/library\/debian:trixie@sha256:[0-9a-f]{64}$/m)
    for (const needed of [
      'google-chrome-stable', 'tigervnc-standalone-server', 'openbox', 'socat', 'fonts-noto-cjk', 'fonts-noto-color-emoji',
      'pulseaudio', 'apt-get upgrade', `playwright-core@${PLAYWRIGHT_CORE_VERSION}`, 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
    ]) expect(file, needed).toContain(needed)
    expect(PLAYWRIGHT_CORE_VERSION).toBe('1.58.2')
    expect(file).toMatch(/^COPY \. \/opt\/harness-browser\/$/m)
    // Google Chrome on both architectures (the spike found a Linux arm64 build), so only Chrome's policy folder.
    expect(file).toMatch(/^COPY policy\.json \/etc\/opt\/chrome\/policies\/managed\//m)
    for (const banned of ['@playwright/mcp', 'novnc', 'websockify', 'EXPOSE', '--mount=type=cache', 'chromium']) expect(file.toLowerCase(), banned).not.toContain(banned.toLowerCase())
  })

  it('entrypoint', () => {
    const file = onDisk('entrypoint.sh')
    for (const flag of [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=', '--window-position=0,0',
      '--window-size=', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-setuid-sandbox', '--no-zygote',
      '--renderer-process-limit=2', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-breakpad',
      '--disable-crash-reporter', '--metrics-recording-only', '--disable-features=TranslateUI', '--disable-extensions',
      '--disk-cache-size=524288000', '--lang=', '--accept-lang=',
    ]) expect(file, flag).toContain(flag)
    for (const banned of ['--headless', '--enable-automation', '--disable-dev-shm-usage']) expect(file, banned).not.toContain(banned)
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) expect(file).toMatch(new RegExp(`rm -f [^\\n]*${lock}`))
    expect(file).toContain('Xvnc :1 -geometry "$SCREEN" -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared')
    // Detached: a subshell's background job is not the script's child, so `wait -n` never sees it end.
    expect(file).toMatch(/^\( openbox [^\n]*& \)$/m)
    expect(file).toMatch(/^\( pulseaudio [^\n]*& \)$/m)
    // Plain: with process ids it missed a browser that had already exited, and the container stayed up without one.
    expect(file.trimEnd()).toMatch(/\nwait -n\nexit \$\?$/)
    expect(file).toMatch(/\/var\/lib\/harness-browser-profile/)
    expect(file).toMatch(/if ! touch "\$PROFILE\/[^"]+"[^\n]*; then[^\n]*exit 3; fi/)
    const ready = file.indexOf('touch /tmp/harness-ready')
    expect(ready).toBeGreaterThan(file.indexOf('http://127.0.0.1:9222/json/version'))
    expect(ready).toBeGreaterThan(file.indexOf('/dev/tcp/127.0.0.1/5900'))
  })

  it('entrypoint starts openbox, and waits until it runs, before the browser', () => {
    const file = onDisk('entrypoint.sh')
    // The spike's keys reached no window until the browser's window had X focus, which openbox gives a window it maps.
    expect(file).toMatch(/^\( openbox --startup "touch \/tmp\/openbox-ready" [^\n]*& \)$/m)
    const openbox = file.indexOf('( openbox ')
    const waited = file.search(/\[ -e \/tmp\/openbox-ready \] && break/)
    expect(openbox).toBeGreaterThan(0)
    expect(waited).toBeGreaterThan(openbox)
    expect(file.indexOf('google-chrome-stable ')).toBeGreaterThan(waited)
  })

  it('entrypoint starts the proxy relay first, and only under PROXY=1', () => {
    const file = onDisk('entrypoint.sh')
    const block = /^if \[ "\$\{PROXY:-\}" = 1 \]; then\n[\s\S]*?^fi$/m.exec(file)?.[0] ?? ''
    expect(block).toContain('node /opt/harness-browser/proxy-relay.mjs')
    expect(file.indexOf(block)).toBeLessThan(file.indexOf('Xvnc :1'))
    // The relay listens only once its start probe passed: no port, or a relay that died, is exit 4.
    expect(block).toMatch(/\/dev\/tcp\/127\.0\.0\.1\/3128/)
    expect(block).toMatch(/if ! \(exec 3<> \/dev\/tcp\/127\.0\.0\.1\/3128\)[^\n]*; then[^\n]*exit 4; fi/)
    for (const flag of ['--proxy-server=http://127.0.0.1:3128', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']) {
      expect(block, flag).toContain(flag)
      expect(file.split(flag).length, flag).toBe(2)
    }
    expect(file).toMatch(/google-chrome-stable [\s\S]*"\$\{PROXY_FLAGS\[@\]\}"[\s\S]*about:blank/)
  })

  it('entrypoint starts the device script, detached, only when DEVICE is set', () => {
    const file = onDisk('entrypoint.sh')
    expect(file).toMatch(/^if \[ -n "\$\{DEVICE:-\}" \]; then \( node \/opt\/harness-browser\/device-inject\.mjs [^\n]*& \); fi$/m)
    expect(file.split('device-inject.mjs').length).toBe(2)
  })

  it('entrypoint, with DEVICE set, is ready only once the device script attached, and exits 5 when it does not in 15 s', () => {
    const file = onDisk('entrypoint.sh')
    // A tab opened right after ready would otherwise report this machine's own values.
    expect(onDisk('device-inject.mjs')).toContain("'/tmp/device-ready'")
    const block = /^ {4}if \[ -n "\$\{DEVICE:-\}" \]; then\n[\s\S]*?^ {4}fi$/m.exec(file)?.[0] ?? ''
    expect(block).toMatch(/for _ in \$\(seq 1 75\); do \[ -e \/tmp\/device-ready \] && break; sleep 0\.2; done/)
    expect(block).toMatch(/if \[ ! -e \/tmp\/device-ready \]; then[^\n]*exit 5; fi/)
    const at = file.indexOf(block)
    expect(at).toBeGreaterThan(file.indexOf('http://127.0.0.1:9222/json/version'))
    expect(file.indexOf('touch /tmp/harness-ready')).toBeGreaterThan(at + block.length)
  })

  it('browser-tools.json names exactly the eleven tools', () => {
    const { tools } = browserTools()
    expect(tools.map(tool => tool.name)).toEqual([
      'browser_navigate', 'browser_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
      'browser_select', 'browser_scroll', 'browser_screenshot', 'browser_tabs', 'browser_wait',
    ])
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy()
      expect(tool.inputSchema.type, tool.name).toBe('object')
    }
    expect(JSON.parse(onDisk('browser-tools.json'))).toEqual({ tools })
  })

  it('the bundle\'s tool list wins over the file', () => {
    vi.stubGlobal('__BROWSER_TOOLS_JSON__', JSON.stringify({ tools: [{ name: 'x', description: 'y', inputSchema: { type: 'object' } }] }))
    expect(browserTools().tools.map(tool => tool.name)).toEqual(['x'])
  })
})
