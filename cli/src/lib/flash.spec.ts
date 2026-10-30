import { describe, expect, it, vi } from 'vitest'
import { flashCommand, flasherScript, scriptUrl, type FlashDeps } from './flash.js'

/**
 * `harness flash` chooses and gets the script, passes the user's flags over untouched, and supplies
 * Windows' private post-write recovery callback. Everything that decides whether a board survives the write lives in the shell script and
 * is deliberately NOT duplicated here, so these assertions stop at the wrapper.
 *
 * Nothing in this file may touch hardware. The one thing that cannot be proven here — that a real
 * board ends up running the firmware — is a manual gate, not a test.
 */

const SCRIPT = '#!/usr/bin/env bash\necho flasher\n'

function harness(over: Partial<FlashDeps> & { cache?: string | null } = {}) {
  const calls: { paths: string[]; args: string[][]; written: string[]; logs: string[]; warns: string[] } =
    { paths: [], args: [], written: [], logs: [], warns: [] }
  let cache = over.cache ?? null
  const deps: Partial<FlashDeps> = {
    fetchScript: over.fetchScript ?? (async () => SCRIPT),
    readCache: over.readCache ?? (() => cache),
    writeCache: over.writeCache ?? ((body) => { cache = body; calls.written.push(body) }),
    run: over.run ?? (async (path, args) => { calls.paths.push(path); calls.args.push(args); return 0 }),
    log: (l) => calls.logs.push(l),
    warn: (l) => calls.warns.push(l),
    platform: over.platform ?? 'darwin',
  }
  return { deps, calls }
}

describe('harness flash — getting the script', () => {
  it('prefers the network copy and caches it', async () => {
    const { deps, calls } = harness()

    expect(await flashCommand([], deps)).toBe(0)
    expect(calls.written).toEqual([SCRIPT])
    // Says which copy it ran. A flasher that silently ran something other than the newest is exactly
    // what the server's `no-store` header exists to prevent.
    expect(calls.logs.join('\n')).toContain(scriptUrl('darwin'))
    expect(calls.warns).toEqual([])
  })

  /** A bench with no connection is a real situation, so the cache is a fallback — but a LOUD one. */
  it('falls back to the cache when the network fails, and warns', async () => {
    const { deps, calls } = harness({
      fetchScript: async () => { throw new Error('getaddrinfo ENOTFOUND') },
      cache: SCRIPT,
    })

    expect(await flashCommand([], deps)).toBe(0)
    const warned = calls.warns.join('\n')
    expect(warned).toContain('CACHED')
    expect(warned).toContain('may be out of date')
    expect(calls.args).toHaveLength(1) // it still ran
  })

  it('refuses, with the manual commands, when there is no network and no cache', async () => {
    const { deps } = harness({
      fetchScript: async () => { throw new Error('offline') },
      cache: null,
    })

    await expect(flashCommand([], deps)).rejects.toThrow(/no cached copy/)
    await expect(flashCommand([], deps)).rejects.toThrow(/curl -fsSL/)
  })

  /**
   * A captive portal or an error page answers 200 with HTML. Writing that to the cache would poison
   * the fallback for every later run, so the shebang check happens before anything is stored — this
   * asserts the caller sees a failure rather than a "successful" flash of nothing.
   */
  it('treats a non-script response as a failure', async () => {
    const { deps, calls } = harness({
      fetchScript: async () => '<html>captive portal</html>',
      cache: null,
    })

    await expect(flashCommand([], deps)).rejects.toThrow(/not a shell script/)
    expect(calls.written).toEqual([])
  })
})

describe('harness flash — handing over the flags', () => {
  /**
   * The wrapper does not parse the flasher's flags, so a flag it has never heard of has to reach the
   * script unchanged. This is what keeps the two from drifting when the script gains an option.
   */
  it('passes every argument through verbatim, including unknown ones', async () => {
    const { deps, calls } = harness()
    const args = ['--detect-only', '--port', '/dev/cu.usbmodem21301', '--totally-new-flag', 'x y']

    await flashCommand(args, deps)

    // Untouched, and still in order — a flag the script grows next month works the day it ships,
    // without this file learning it exists. `--yes` leads; see the next test for why.
    expect(calls.args[0]).toEqual(['--yes', ...args])
  })

  it('never asks the person who typed `harness flash` to confirm', async () => {
    // The script's prompt is for the standalone `curl | bash` case, where the operator may not know what
    // is plugged in. Reaching a board through the product's own command, at the product's own device, is
    // a different situation — and the check that actually prevents damage is the script refusing to write
    // to anything that is not an ESP32-S3. Passing --yes first also leaves the user's own flags able to
    // override anything they collide with.
    const { deps, calls } = harness()

    await flashCommand([], deps)

    expect(calls.args[0]).toEqual(['--yes'])
  })

  /** `harness flash --detect-only` has to be usable in a shell condition, so the code is not swallowed. */
  it("returns the script's own exit code", async () => {
    const { deps } = harness({ run: async () => 3 })

    expect(await flashCommand(['--detect-only'], deps)).toBe(3)
  })

  it('explains itself when bash is missing rather than failing bare', async () => {
    const { deps } = harness({
      run: async () => { throw Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) },
    })

    await expect(flashCommand([], deps)).rejects.toThrow(
      'bash was not found on PATH, and the flasher is a bash script.\n'
      + 'Install bash, or run it yourself on a machine that has one:\n'
      + `  curl -fsSL ${scriptUrl('darwin')} -o flash-circle.sh\n`
      + '  bash flash-circle.sh',
    )
  })
})

describe('harness flash — where it points', () => {
  it('builds the URL from WEB_URL, so a local web app is used in dev', () => {
    // WEB_URL already falls back to loopback when BACKEND_WS_URL is local (config/env.ts), which is
    // why this command needs no environment variable of its own.
    expect(scriptUrl('darwin')).toMatch(/^https?:\/\/.+\/flash-circle\.sh$/)
    expect(scriptUrl('linux')).toBe(scriptUrl('darwin'))
  })
})

describe('harness flash — on Windows', () => {
  const PS1 = '# flash-circle.ps1\r\nWrite-Output flasher\r\n'

  it('fetches the PowerShell flasher and runs its own cache filename', async () => {
    const urls: string[] = []
    const { deps, calls } = harness({ fetchScript: async (url) => { urls.push(url); return PS1 } })

    expect(await flashCommand(['--detect-only'], { ...deps, platform: 'win32' })).toBe(0)
    expect(urls).toEqual([scriptUrl('win32')])
    expect(scriptUrl('win32')).toMatch(/\/flash-circle\.ps1$/)
    expect(calls.written).toEqual([PS1])
    expect(calls.paths[0]).toMatch(/[/\\]flash-circle\.ps1$/)
    expect(calls.args[0]).toEqual(['--yes', '--detect-only'])
    expect(calls.warns).toEqual([])
  })

  it.each(['\n', '\r\n'])('accepts the exact marker with %j line endings', async (newline) => {
    const body = `# flash-circle.ps1${newline}Write-Output flasher${newline}`
    const { deps, calls } = harness({ fetchScript: async () => body })

    expect(await flashCommand([], { ...deps, platform: 'win32' })).toBe(0)
    expect(calls.written).toEqual([body])
    expect(calls.args).toEqual([['--yes']])
  })

  it.each([
    '<html>captive portal</html>',
    '# flash-circle.ps1 trailing text\nWrite-Output flasher\n',
    '# flash-circle.ps1-malicious\r\nWrite-Output flasher\r\n',
    '# flash-circle.ps1 \r\nWrite-Output flasher\r\n',
    '\n# flash-circle.ps1\nWrite-Output flasher\n',
    '# flash-circle.ps1\rWrite-Output flasher\r',
    '#!/usr/bin/env bash\necho flasher\n',
  ])('rejects a nonmatching first line and loudly uses the cache: %j', async (body) => {
    const { deps, calls } = harness({ fetchScript: async () => body, cache: PS1 })

    expect(await flashCommand([], { ...deps, platform: 'win32' })).toBe(0)
    expect(calls.written).toEqual([])
    expect(calls.warns.join('\n')).toContain('not the PowerShell flasher')
    expect(calls.warns.join('\n')).toContain('CACHED')
    expect(calls.warns.join('\n')).toContain('flash-circle.ps1')
    expect(calls.paths[0]).toMatch(/[/\\]flash-circle\.ps1$/)
    expect(calls.args).toEqual([['--yes']])
  })

  it('runs Windows PowerShell with the path and arguments untouched and no profile or prompt', () => {
    const path = "C:\\Users\\Nguyễn Văn A' & 100%\\.harness\\flasher\\flash-circle.ps1"
    const args = ['--yes', '--port', 'COM3', '--unknown', "x y' & 100%"]

    expect(flasherScript('win32').command(path, args)).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args],
    })
    expect(flasherScript('darwin').command('/x/flash-circle.sh', ['--yes'])).toEqual({
      file: 'bash', args: ['/x/flash-circle.sh', '--yes'],
    })
    expect(flasherScript('linux').command('/x/flash-circle.sh', ['--yes'])).toEqual({
      file: 'bash', args: ['/x/flash-circle.sh', '--yes'],
    })
  })

  it('gives manual PowerShell commands when offline with no cache', async () => {
    const { deps, calls } = harness({ fetchScript: async () => { throw new Error('offline') } })

    await expect(flashCommand([], { ...deps, platform: 'win32' })).rejects.toThrow(
      `could not download the flasher from ${scriptUrl('win32')} (offline), and no cached copy exists.\n`
      + 'With a working connection you can always run it by hand:\n'
      + `  irm ${scriptUrl('win32')} -OutFile flash-circle.ps1\n`
      + '  powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1',
    )
    expect(calls.args).toEqual([])
    expect(calls.written).toEqual([])
  })

  it('explains how to run manually when Windows PowerShell is missing', async () => {
    const { deps } = harness({
      fetchScript: async () => PS1,
      run: async () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) },
    })

    await expect(flashCommand([], { ...deps, platform: 'win32' })).rejects.toThrow(
      'Windows PowerShell (powershell.exe) was not found, and the flasher is a PowerShell script.\n'
      + 'Run it yourself from a PowerShell window:\n'
      + `  irm ${scriptUrl('win32')} -OutFile flash-circle.ps1\n`
      + '  powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1',
    )
  })

  it('preserves Windows exit codes and leaves unknown flags in order after --yes', async () => {
    const args = ['--port', 'COM10', '--new-flag', "x y' & 100%"]
    const paths: string[] = []
    const received: string[][] = []
    const { deps } = harness({
      fetchScript: async () => PS1,
      run: async (path, flags) => { paths.push(path); received.push(flags); return 130 },
    })

    expect(await flashCommand(args, { ...deps, platform: 'win32' })).toBe(130)
    expect(paths[0]).toMatch(/[/\\]flash-circle\.ps1$/)
    expect(received).toEqual([['--yes', ...args]])
  })
})

describe('harness flash — successful Windows flash recovery', () => {
  const capability = { HARNESS_FLASH_RECOVERY_NODE: 'C:\\runtime\\node.exe', HARNESS_FLASH_RECOVERY_ARGS: '["C:\\\\cli\\\\cli.js"]' }

  it('handles the private completion before fetching or running another flasher', async () => {
    const complete = vi.fn(async () => {})
    const { deps, calls } = harness({ fetchScript: async () => '# flash-circle.ps1\n' })
    expect(await flashCommand(['__complete', 'COM3'], { ...deps, platform: 'win32', environment: capability, complete })).toBe(0)
    expect(complete).toHaveBeenCalledWith('COM3')
    expect(calls.paths).toEqual([])
    expect(calls.written).toEqual([])
  })

  it.each([
    { platform: 'win32', environment: {}, args: ['__complete', 'COM3'] },
    { platform: 'darwin', environment: capability, args: ['__complete', 'COM3'] },
    { platform: 'win32', environment: capability, args: ['__complete'] },
    { platform: 'win32', environment: capability, args: ['__complete', 'COM3', 'COM4'] },
  ] as const)('refuses a completion without the Windows capability or exact arguments: %j', async ({ platform, environment, args }) => {
    const complete = vi.fn(async () => {})
    const { deps } = harness({ fetchScript: async () => platform === 'win32' ? '# flash-circle.ps1\n' : SCRIPT })
    await expect(flashCommand([...args], { ...deps, platform, environment, complete })).rejects.toThrow(/completion/)
    expect(complete).not.toHaveBeenCalled()
  })

  it('passes callback capability only to the Windows flasher child without changing the caller environment', async () => {
    const environment = { KEEP: 'present' }
    let child: NodeJS.ProcessEnv | undefined
    const { deps } = harness({ fetchScript: async () => '# flash-circle.ps1\n', run: async (_path, _args, given) => { child = given; return 0 } })
    await flashCommand([], { ...deps, platform: 'win32', environment })
    expect(child?.KEEP).toBe('present')
    expect(child?.HARNESS_FLASH_RECOVERY_NODE).toBe(process.execPath)
    expect(JSON.parse(child!.HARNESS_FLASH_RECOVERY_ARGS!)).toEqual([...process.execArgv, process.argv[1]])
    expect(environment).toEqual({ KEEP: 'present' })
  })
})
