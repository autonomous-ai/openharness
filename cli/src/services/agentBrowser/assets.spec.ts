import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — the tool server's helpers are plain ESM, run by Node inside the browser's container.
import { navigable } from '../../../assets/browser/browser-tools-lib.mjs'
// @ts-expect-error — the relay is plain ESM, run by Node inside the browser's container.
import { createRelay, refusalLog } from '../../../assets/browser/proxy-relay.mjs'
import { browserTools } from '../../lib/browserToolsAsset.js'
import { browserAssetsHash, browserContextFiles, PLAYWRIGHT_CORE_VERSION } from './assets.js'

const folder = new URL('../../../assets/browser/', import.meta.url)
const onDisk = (name: string) => readFileSync(new URL(name, folder), 'utf8')
// `*.d.mts` files type the scripts for the CLI's own imports; the image never needs them.
const assetNames = () => readdirSync(folder).filter(name => !name.endsWith('.d.mts')).sort()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

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

  it('entrypoint\'s stop closes the browser over CDP, as a person closes it, before any signal', () => {
    const file = onDisk('entrypoint.sh')
    expect(file).toMatch(/^trap stop_browser TERM INT$/m)
    const stop = /^stop_browser\(\) \{\n([\s\S]*?)\n\}$/m.exec(file)?.[1] ?? ''
    const close = stop.indexOf("send('Browser.close')")
    expect(close, 'Browser.close').toBeGreaterThan(-1)
    // Bounded, inside podman's 10 s stop (containers.ts STOP_SECONDS), so a browser that does not answer still goes.
    expect(stop).toMatch(/timeout [1-8] node /)
    expect(stop.indexOf('kill -TERM "$BROWSER"')).toBeGreaterThan(close)
    expect(stop).toMatch(/wait "\$BROWSER"/)
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

  it('entrypoint always starts the proxy relay first, as its own child, and waits for its port', () => {
    const file = onDisk('entrypoint.sh')
    // Every request the browser makes goes through it, proxy or not: it refuses the host's own addresses.
    expect(file).toMatch(/^node \/opt\/harness-browser\/proxy-relay\.mjs >> \/tmp\/proxy-relay\.log 2>&1 &$/m)
    expect(file.split('proxy-relay.mjs').length).toBe(2)
    const started = file.indexOf('node /opt/harness-browser/proxy-relay.mjs')
    expect(started).toBeLessThan(file.indexOf('Xvnc :1'))
    const waited = file.search(/^if ! \(exec 3<> \/dev\/tcp\/127\.0\.0\.1\/3128\)[^\n]*; then$/m)
    expect(waited).toBeGreaterThan(started)
    // Its start probe runs only with a proxy: no port then is exit 4, `proxy_failed`.
    const failed = /^if ! \(exec 3<> \/dev\/tcp\/127\.0\.0\.1\/3128\)[^\n]*; then\n([\s\S]*?)\nfi$/m.exec(file)?.[1] ?? ''
    expect(failed).toMatch(/^ {2}if \[ "\$\{PROXY:-\}" = 1 \]; then[^\n]*exit 4; fi$/m)
    expect(failed).toMatch(/exit 1$/)
    expect(file.indexOf('google-chrome-stable ')).toBeGreaterThan(waited)
  })

  it('entrypoint sends every request of the browser, loopback included, through the relay', () => {
    const file = onDisk('entrypoint.sh')
    const browser = /^google-chrome-stable [\s\S]*?about:blank/m.exec(file)?.[0] ?? ''
    for (const flag of [
      '--proxy-server=http://127.0.0.1:3128',
      // Quoted: bare, bash reads `<` as a redirection.
      '"--proxy-bypass-list=<-loopback>"',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]) {
      expect(browser, flag).toContain(flag)
      expect(file.split(flag).length, flag).toBe(2)
    }
    expect(file).not.toContain('PROXY_FLAGS')
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

  it('the tools open only http and https URLs, and about:blank: never a file, so never the proxy secret', () => {
    for (const url of ['https://mail.google.com/', 'http://example.com/a?b=1', 'HTTPS://Example.com', 'about:blank']) expect(navigable(url), url).toBe(url)
    for (const url of [
      'file:///run/secrets/harness-proxy', 'FILE:///etc/passwd', ' file:///run/secrets/harness-proxy', 'view-source:file:///run/secrets/harness-proxy',
      'chrome://settings', 'javascript:fetch(1)', 'data:text/html,x', 'filesystem:http://a/x', 'about:config', 'example.com', '',
    ]) expect(() => navigable(url), url).toThrow('Only http and https URLs open in the Browser')
    const navigate = /async browser_navigate\(\{ url \}\) \{\n([\s\S]*?)\n {2}\},/.exec(onDisk('browser-tools.mjs'))?.[1] ?? ''
    expect(navigate).toMatch(/p\.goto\(navigable\(url\),/)
    // No tool picks a file for a page: no upload, no set-input-files, no file chooser.
    for (const banned of ['setInputFiles', 'filechooser', 'FileChooser']) expect(onDisk('browser-tools.mjs'), banned).not.toContain(banned)
  })

  it('Chrome\'s policy blocks every file URL, for the person and the agent alike', () => {
    expect(JSON.parse(onDisk('policy.json')).URLBlocklist).toEqual(['file://*'])
  })

  it('the relay logs its first 50 refusals, then one line a minute with how many more', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const log = refusalLog((line: string) => lines.push(line))
    for (let n = 0; n < 1000; n += 1) log(n % 2 ? 'loopback' : 'gvproxy')
    expect(lines).toHaveLength(50)
    expect(lines[0]).toBe('proxy relay: refused a gvproxy destination')
    expect(lines[1]).toBe('proxy relay: refused a loopback destination')
    vi.advanceTimersByTime(60_000)
    expect(lines.slice(50)).toEqual(['proxy relay: refused 950 more destinations'])
    vi.advanceTimersByTime(600_000)
    expect(lines).toHaveLength(51)
    log('loopback')
    log('loopback')
    vi.advanceTimersByTime(60_000)
    expect(lines.slice(51)).toEqual(['proxy relay: refused 2 more destinations'])
  })

  it('a page looping fetches to loopback gets 403 each time, and the relay logs only the first 50', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server: Server = createRelay(null, [])
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    try {
      for (let n = 0; n < 80; n += 1) {
        const status = await new Promise<number | undefined>((done, fail) => {
          request({ host: '127.0.0.1', port, path: 'http://127.0.0.1:9/', headers: { connection: 'close' } }, (res) => { res.resume(); done(res.statusCode) })
            .on('error', fail).end()
        })
        expect(status).toBe(403)
      }
    } finally {
      server.close()
    }
    expect(errors).toHaveBeenCalledTimes(50)
  })

  it('entrypoint appends every log, and keeps each to its last 512 KB once past 1 MB, every 10 s', () => {
    const file = onDisk('entrypoint.sh')
    // Appended (O_APPEND), so a log cut back from outside gets its writer's next line at its new end, not past a hole.
    const logs = [...file.matchAll(/>+ \/tmp\/[\w-]+\.log/g)].map(match => match[0])
    expect(logs.length).toBeGreaterThanOrEqual(6)
    for (const log of logs) expect(log).toMatch(/^>> /)
    // Detached, like openbox: `wait -n` never sees it.
    expect(file).toMatch(/^\( while sleep 10; do cut_logs \/tmp\/\*\.log; done & \)$/m)
    expect(file.indexOf('( while sleep 10;')).toBeLessThan(file.indexOf('node /opt/harness-browser/proxy-relay.mjs'))
    const cut = /^cut_logs\(\) \{\n[\s\S]*?\n\}$/m.exec(file)?.[0] ?? ''
    const dir = mkdtempSync(join(tmpdir(), 'cut-logs-'))
    try {
      const big = join(dir, 'chrome.log')
      const small = join(dir, 'xvnc.log')
      const content = Buffer.alloc(2 * 1024 * 1024, 'a')
      content.write('the end\n', content.length - 8)
      writeFileSync(big, content)
      writeFileSync(small, 'started\n')
      execFileSync('bash', ['-c', `${cut}\ncut_logs "$@"`, 'bash', big, small, join(dir, 'missing.log')])
      const kept = readFileSync(big)
      expect(kept.length).toBe(512 * 1024)
      expect(kept.subarray(-8).toString()).toBe('the end\n')
      expect(readFileSync(small, 'utf8')).toBe('started\n')
      expect(readdirSync(dir).sort()).toEqual(['chrome.log', 'xvnc.log'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
