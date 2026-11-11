import { beforeEach, describe, expect, it } from 'vitest'
import { browserLimit, Containers } from './containers.js'
import { PodmanError, type Podman } from './podman.js'
import { defaultSettings, settingsHash, type BrowserSettings } from './settings.js'

const GiB = 1024 ** 3
const IMAGE = 'harness-browser:abc123-2026w46'
const base: BrowserSettings = defaultSettings({ timeZone: 'Asia/Ho_Chi_Minh', languages: 'vi-VN, en-US' })
const proxy = { scheme: 'socks5' as const, host: 'proxy.example', port: 1080, username: 'u', password: 's3cret-pass' }

interface FakeCall { args: string[]; stdin: string }
interface FakeReply { stdout?: string; stderr?: string; code?: number }

/**
 * Podman as Containers sees it, answered in this process. The script fake (fakePodman.ts) is a Node process start per
 * call; a start here makes 7 calls, and under load a test passed its 5 s. How a call reaches a process, its stdin and
 * its error text are podman.spec's to test; the error below is podman.ts's `podman <verb> failed: <stderr>`.
 */
function inProcessPodman() {
  const replies: Record<string, FakeReply[]> = {}
  const made: FakeCall[] = []
  const podman = {
    async run(args: string[], opts: { stdin?: string } = {}) {
      made.push({ args, stdin: opts.stdin ?? '' })
      const line = args.join(' ')
      // The longest prefix wins, as in fakePodman.ts.
      const key = Object.keys(replies).filter(k => line === k || line.startsWith(`${k} `)).sort((a, b) => b.length - a.length)[0]
      const answers = key === undefined ? [{}] : replies[key]!
      const { stdout = '', stderr = '', code = 0 } = answers.length > 1 ? answers.shift()! : answers[0]!
      if (code !== 0) throw new PodmanError('podman_failed', `podman ${args[0]} failed: ${stderr.trim()}`)
      return { stdout, stderr }
    },
  }
  return {
    podman: podman as Podman,
    /** Each answer once, in turn; the last one for every call after. */
    reply: (prefix: string, ...answers: FakeReply[]) => { replies[prefix] = answers },
    calls: () => made,
  }
}

let fake: ReturnType<typeof inProcessPodman>
let logged: string[]
let containers: Containers
beforeEach(() => {
  fake = inProcessPodman()
  fake.reply('ps', { stdout: '[]' })
  logged = []
  containers = new Containers(fake.podman, 'd1', line => logged.push(line))
})

const argvs = () => fake.calls().map(call => call.args)
const named = (verb: string): FakeCall[] => fake.calls().filter(call => call.args[0] === verb)
const createArgv = () => named('create')[0]!.args
/** `--flag value` pairs of an argv, as `flag value` strings. */
const pairs = (args: string[]) => args.slice(1).map((arg, i) => `${arg} ${args[i + 2]}`)
const entry = (agent: string, daemon: string, more: Record<string, unknown> = {}) =>
  ({ Names: [`harness-browser-${agent}`], Image: `localhost/${IMAGE}`, State: 'running', ExitCode: 0, Labels: { 'harness.agent': agent, 'harness.daemon': daemon }, ...more })
const listed = (...entries: object[]) => fake.reply('ps', { stdout: JSON.stringify(entries) })
const applied = (s: BrowserSettings, timeZone: string) => settingsHash({ ...s, timeZone })

describe('Containers', () => {
  it('create args', async () => {
    expect(await containers.start('a1', 'a1', IMAGE, base, 'Asia/Ho_Chi_Minh', '')).toEqual({ limitsDropped: [] })
    const labels = ['--label', 'harness.agent=a1', '--label', 'harness.daemon=d1']
    expect(argvs().slice(0, 2)).toEqual([
      ['network', 'create', '--ignore', ...labels, 'harness-browser-a1'],
      ['volume', 'create', '--ignore', ...labels, 'harness-browser-a1'],
    ])
    const args = createArgv()
    expect(pairs(args)).toEqual(expect.arrayContaining([
      '--name harness-browser-a1', '--label harness.agent=a1', '--label harness.daemon=d1',
      `--label harness.settings=${applied(base, 'Asia/Ho_Chi_Minh')}`,
      '--network harness-browser-a1',
      '--cap-drop ALL', '--security-opt no-new-privileges',
      '--tmpfs /tmp:rw,size=256m', '--tmpfs /home/browser:rw,size=256m,mode=1777', '--tmpfs /var/tmp:rw,size=16m', '--tmpfs /run:rw,size=16m',
      '-v harness-browser-a1:/var/lib/harness-browser-profile',
      '--memory 2g', '--cpus 2', '--pids-limit 512', '--shm-size 1g',
      '-e TZ=Asia/Ho_Chi_Minh', '-e ACCEPT_LANG=vi-VN, en-US', '-e SCREEN=1920x1080',
    ]))
    expect(args).toContain('--read-only')
    expect(args.at(-1)).toBe(IMAGE)
    for (const refused of ['-p', '--publish', '--add-host', '--secret']) expect(args).not.toContain(refused)
    expect(args.some(arg => arg.startsWith('PROXY') || arg.startsWith('DEVICE'))).toBe(false)
    expect(argvs().at(-1)).toEqual(['start', 'harness-browser-a1'])
  })

  it("a browser whose profile is not its agent's id is created, started, checked, exec'd into, stopped and removed under the profile's names, labelled with the agent", async () => {
    // b1's own container, named after its id and with the very settings asked for, is not this browser: after a move,
    // that name can be another agent's.
    const hash = settingsHash({ ...base, timeZone: 'UTC', proxy: { ...proxy, password: 'id-1' } })
    listed(entry('b1', 'd1', { Labels: { 'harness.agent': 'b1', 'harness.daemon': 'd1', 'harness.settings': hash } }))
    await containers.start('b1', 'a1', IMAGE, { ...base, proxy }, 'UTC', 'id-1')
    const labels = ['--label', 'harness.agent=b1', '--label', 'harness.daemon=d1']
    expect(argvs().map(args => args[0] === 'create' ? 'create' : args)).toEqual([
      ['network', 'create', '--ignore', ...labels, 'harness-browser-a1'],
      ['volume', 'create', '--ignore', ...labels, 'harness-browser-a1'],
      ['ps', '-a', '--filter', 'label=harness.agent=b1', '--filter', 'label=harness.daemon=d1', '--format', 'json'],
      ['secret', 'rm', 'harness-proxy-a1'],
      ['secret', 'create', 'harness-proxy-a1', '-'],
      'create',
      ['start', 'harness-browser-a1'],
    ])
    expect(pairs(createArgv())).toEqual(expect.arrayContaining([
      '--name harness-browser-a1', '--label harness.agent=b1', '--label harness.daemon=d1', `--label harness.settings=${hash}`,
      '--network harness-browser-a1', '-v harness-browser-a1:/var/lib/harness-browser-profile',
      '--secret harness-proxy-a1,target=harness-proxy',
    ]))
    expect(await containers.ready('a1')).toBe(true)
    expect(argvs().at(-1)).toEqual(['exec', 'harness-browser-a1', 'test', '-f', '/tmp/harness-ready'])
    expect(containers.execArgs('a1', ['socat', '-', 'TCP:127.0.0.1:5900'])).toEqual(['exec', '-i', 'harness-browser-a1', 'socat', '-', 'TCP:127.0.0.1:5900'])
    const stopped = argvs().length
    await containers.stop('a1')
    await containers.remove('a1')
    expect(argvs().slice(stopped)).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a1'], ['network', 'rm', 'harness-browser-a1'], ['secret', 'rm', 'harness-proxy-a1'],
      ['rm', '--force', '--time', '10', 'harness-browser-a1'], ['network', 'rm', 'harness-browser-a1'], ['secret', 'rm', 'harness-proxy-a1'],
      ['volume', 'rm', 'harness-browser-a1'],
    ])
    // A start that fails cleans up under the profile's names too.
    fake.reply('create', { code: 125, stderr: 'Error: harness-browser:abc123-2026w46: image not known' })
    await expect(containers.start('b1', 'a1', IMAGE, base, 'UTC', '')).rejects.toThrow('image not known')
    expect(argvs().slice(-3)).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a1'], ['network', 'rm', 'harness-browser-a1'], ['secret', 'rm', 'harness-proxy-a1'],
    ])
    // Nothing named after b1 was ever made, removed or run.
    expect(argvs().flat().filter(arg => /harness-(browser|proxy)-b1/.test(arg))).toEqual([])
  })

  // Measured in the spike: without the mode the tmpfs is root's alone, and Chromium crashes at start.
  it('the HOME tmpfs has mode=1777', async () => {
    await containers.start('a1', 'a1', IMAGE, base, 'Asia/Ho_Chi_Minh', '')
    expect(pairs(createArgv()).filter(pair => pair.startsWith('--tmpfs /home/'))).toEqual(['--tmpfs /home/browser:rw,size=256m,mode=1777'])
  })

  it('with a proxy', async () => {
    // Removed, then made: Podman 4.6 has no `secret create --replace` (added in 4.7).
    fake.reply('secret rm', { code: 1, stderr: 'Error: harness-proxy-a1: no such secret' })
    await containers.start('a1', 'a1', IMAGE, { ...base, proxy }, 'Europe/Berlin', 'id-1')
    const secret = named('secret')
    expect(secret.map(call => call.args)).toEqual([['secret', 'rm', 'harness-proxy-a1'], ['secret', 'create', 'harness-proxy-a1', '-']])
    expect(JSON.parse(secret[1]!.stdin)).toEqual(proxy)
    expect(pairs(createArgv())).toEqual(expect.arrayContaining(['--secret harness-proxy-a1,target=harness-proxy', '-e PROXY=1', '-e TZ=Europe/Berlin']))
    // The password reaches Podman on stdin only: never an argument, an environment variable or a log line.
    expect(fake.calls().flatMap(call => call.args).some(arg => arg.includes(proxy.password))).toBe(false)
    expect(logged.join('\n')).not.toContain(proxy.password)
  })

  it('the settings label holds a random id in place of the password, so it says nothing about the password', async () => {
    const labelOf = async (password: string, secretId: string) => {
      await containers.start('a1', 'a1', IMAGE, { ...base, proxy: { ...proxy, password } }, 'UTC', secretId)
      return pairs(named('create').at(-1)!.args).find(pair => pair.startsWith('--label harness.settings='))!
    }
    const first = await labelOf(proxy.password, 'id-1')
    expect(await labelOf('another-pass', 'id-1')).toBe(first)
    // A new password comes with a new id, and the container is created again.
    expect(await labelOf(proxy.password, 'id-2')).not.toBe(first)
    expect(first).not.toContain(applied({ ...base, proxy }, 'UTC'))
  })

  it('a start that fails removes what it made: its container, network and secret', async () => {
    fake.reply('create', { code: 125, stderr: 'Error: harness-browser:abc123-2026w46: image not known' })
    await expect(containers.start('a1', 'a1', IMAGE, { ...base, proxy }, 'UTC', 'id-1')).rejects.toMatchObject({ state: 'podman_failed' })
    expect(argvs().slice(-3)).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a1'], ['network', 'rm', 'harness-browser-a1'], ['secret', 'rm', 'harness-proxy-a1'],
    ])
    // A clean-up that fails too is logged, and the start's own failure is the one returned.
    fake.reply('network rm', { code: 1, stderr: 'Error: network is being used' })
    await expect(containers.start('a1', 'a1', IMAGE, base, 'UTC', '')).rejects.toThrow('image not known')
    expect(logged.at(-1)).toContain('network is being used')
  })

  it('without a proxy, the secret an earlier proxy left is removed', async () => {
    fake.reply('secret rm', { code: 1, stderr: 'Error: harness-proxy-a1: no such secret' })
    await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')
    expect(named('secret').map(call => call.args)).toEqual([['secret', 'rm', 'harness-proxy-a1']])
    expect(named('start')).toHaveLength(1)
  })

  it('with a device', async () => {
    const device = { gpuVendor: 'Intel Inc.', gpuRenderer: 'Intel Iris', cpuCores: 8, memoryGb: 16 }
    await containers.start('a1', 'a1', IMAGE, { ...base, device }, 'UTC', '')
    expect(pairs(createArgv())).toContain(`-e DEVICE=${JSON.stringify(device)}`)
  })

  it('start is idempotent', async () => {
    listed(entry('a1', 'd1', { Labels: { 'harness.agent': 'a1', 'harness.daemon': 'd1', 'harness.settings': applied(base, 'UTC') } }))
    expect(await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')).toEqual({ limitsDropped: [] })
    expect(argvs().map(args => args[0])).toEqual(['network', 'volume', 'ps'])
    // One that exited is started again as it is.
    listed(entry('a1', 'd1', { State: 'exited', ExitCode: 137, Labels: { 'harness.agent': 'a1', 'harness.daemon': 'd1', 'harness.settings': applied(base, 'UTC') } }))
    await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')
    expect(argvs().slice(3).map(args => args[0])).toEqual(['network', 'volume', 'ps', 'start'])
    expect(named('create')).toEqual([])
  })

  const labels = { 'harness.agent': 'a1', 'harness.daemon': 'd1', 'harness.settings': applied(base, 'UTC') }
  it.each([
    ['an older image', { Image: 'localhost/harness-browser:old-2026w45', Labels: labels }],
    ['a different settings label', { Labels: { ...labels, 'harness.settings': 'other' } }],
  ])('a container on %s is created again and keeps its volume', async (_, old) => {
    listed(entry('a1', 'd1', old))
    await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')
    expect(argvs()).toContainEqual(['rm', '--force', '--time', '10', 'harness-browser-a1'])
    expect(named('create')).toHaveLength(1)
    expect(named('volume').map(call => call.args[1])).toEqual(['create'])
  })

  it('refused limit is dropped and logged', async () => {
    // crun's refusal on a rootless machine without the memory controller (the prior art's pattern; not seen on macOS).
    fake.reply('create --memory 2g', { code: 125, stderr: 'Error: OCI runtime error: crun: the requested cgroup controller `memory` is not available' })
    expect(await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')).toEqual({ limitsDropped: ['memory'] })
    const creates = named('create').map(call => call.args)
    expect(creates).toHaveLength(2)
    expect(creates[1]).not.toContain('--memory')
    expect(pairs(creates[1]!)).toEqual(expect.arrayContaining(['--cpus 2', '--pids-limit 512', '--shm-size 1g']))
    expect(logged).toEqual([expect.stringContaining('memory')])
  })

  it('a refusal that names no limit fails, and an agent id or a profile that reads like one drops nothing', async () => {
    fake.reply('create', { code: 125, stderr: 'Error: OCI runtime error: crun: harness-browser-cpu-bot: mount of /dev/shm refused' })
    await expect(containers.start('cpu-bot', 'cpu-bot', IMAGE, base, 'UTC', '')).rejects.toMatchObject({ state: 'podman_failed' })
    expect(named('create')).toHaveLength(1)
    fake.reply('create', { code: 125, stderr: 'Error: OCI runtime error: crun: harness-browser-pids-2: mount of /dev/shm refused' })
    await expect(containers.start('a1', 'pids-2', IMAGE, base, 'UTC', '')).rejects.toMatchObject({ state: 'podman_failed' })
    expect(named('create')).toHaveLength(2)
    expect(logged.join('\n')).not.toContain('limit')
  })

  it('a create refused because the name is in use removes that container and creates again, once; a second refusal fails', async () => {
    // The container a previous agent's failed stop left under this name, labelled with that agent: no listing of
    // this agent finds it. Podman's words.
    const inUse = { code: 125, stderr: 'Error: creating container storage: the container name "harness-browser-a1" is already in use by 5cce206ab3bd. You have to remove that container to be able to reuse that name: that name is already in use' }
    fake.reply('create', inUse, {})
    expect(await containers.start('b1', 'a1', IMAGE, base, 'UTC', '')).toEqual({ limitsDropped: [] })
    expect(argvs().slice(4).map(args => args[0] === 'create' ? 'create' : args.join(' '))).toEqual([
      'create', 'rm --force --time 10 harness-browser-a1', 'create', 'start harness-browser-a1',
    ])
    // Every limit is still asked for: nothing was dropped for it.
    expect(pairs(createArgv())).toEqual(expect.arrayContaining(['--memory 2g', '--cpus 2', '--pids-limit 512']))
    expect(logged).toEqual([])

    fake.reply('create', inUse)
    const before = named('create').length
    await expect(containers.start('b1', 'a1', IMAGE, base, 'UTC', '')).rejects.toThrow('already in use')
    expect(named('create').length - before).toBe(2)
  })

  it('stop keeps the volume and removes the network and the secret, start creates the network again', async () => {
    await containers.stop('a1')
    // A network still used by a container, even a stopped one, cannot be removed, so the container goes too.
    // The proxy secret goes too: the password is in Podman only while its container is.
    expect(argvs()).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a1'], ['network', 'rm', 'harness-browser-a1'], ['secret', 'rm', 'harness-proxy-a1'],
    ])
    await containers.start('a1', 'a1', IMAGE, base, 'UTC', '')
    expect(argvs()[3]![0]).toBe('network')
    expect(argvs()[3]![1]).toBe('create')
  })

  it('remove deletes container, volume, network and secret, and what is already gone is not an error', async () => {
    fake.reply('network rm', { code: 1, stderr: 'Error: unable to find network with name or ID harness-browser-a1: network not found' })
    fake.reply('secret rm', { code: 1, stderr: 'Error: no such secret' })
    await containers.remove('a1')
    expect(argvs()).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a1'],
      ['network', 'rm', 'harness-browser-a1'],
      ['secret', 'rm', 'harness-proxy-a1'],
      ['volume', 'rm', 'harness-browser-a1'],
    ])
    fake.reply('volume rm', { code: 2, stderr: 'Error: volume is being used' })
    await expect(containers.remove('a1')).rejects.toMatchObject({ state: 'podman_failed' })
  })

  it("sweep spares another daemon's containers and every unlisted volume", async () => {
    listed(entry('a1', 'd1'), entry('a9', 'd1', { State: 'exited' }), entry('a5', 'd2'))
    expect(await containers.sweep(new Set(['a1']))).toBe(1)
    expect(argvs()[0]).toEqual(['ps', '-a', '--filter', 'label=harness.daemon=d1', '--format', 'json'])
    expect(argvs().slice(1)).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-a9'], ['network', 'rm', 'harness-browser-a9'], ['secret', 'rm', 'harness-proxy-a9'],
    ])
  })

  it("sweep stops a stray by its own name, and never the container named after the stray's agent", async () => {
    // a1's browser went with its pane to b1, which runs it as harness-browser-a1. a1 ran again, started a new one
    // (p2) and is gone: its stray is p2, and harness-browser-a1 is b1's.
    listed(entry('b1', 'd1', { Names: ['harness-browser-a1'] }), entry('a1', 'd1', { Names: ['harness-browser-p2'], State: 'exited' }))
    expect(await containers.sweep(new Set(['b1']))).toBe(1)
    expect(argvs().slice(1)).toEqual([
      ['rm', '--force', '--time', '10', 'harness-browser-p2'], ['network', 'rm', 'harness-browser-p2'], ['secret', 'rm', 'harness-proxy-p2'],
    ])
  })

  it('running, ready, exitCode and execArgs', async () => {
    listed(entry('a1', 'd1'), entry('a2', 'd1', { State: 'exited' }), entry('a5', 'd2'))
    expect(await containers.running()).toEqual(['a1'])
    expect(argvs()[0]).toEqual(['ps', '--filter', 'label=harness.daemon=d1', '--format', 'json'])
    listed(entry('a2', 'd1', { State: 'exited', ExitCode: 3 }))
    expect(await containers.exitCode('a2')).toBe(3)
    expect(argvs().at(-1)).toEqual(['ps', '-a', '--filter', 'label=harness.agent=a2', '--filter', 'label=harness.daemon=d1', '--format', 'json'])
    listed(entry('a2', 'd1'))
    expect(await containers.exitCode('a2')).toBeNull()
    listed()
    expect(await containers.exitCode('a2')).toBeNull()
    expect(await containers.ready('a1')).toBe(true)
    expect(argvs().at(-1)).toEqual(['exec', 'harness-browser-a1', 'test', '-f', '/tmp/harness-ready'])
    fake.reply('exec', { code: 1 })
    expect(await containers.ready('a1')).toBe(false)
    expect(containers.execArgs('a1', ['socat', '-', 'TCP:127.0.0.1:5900'])).toEqual(['exec', '-i', 'harness-browser-a1', 'socat', '-', 'TCP:127.0.0.1:5900'])
  })
  it('a ps that does not answer in JSON fails, and an empty answer is no container', async () => {
    fake.reply('ps', { stdout: 'Error: something else' })
    await expect(containers.running()).rejects.toMatchObject({ state: 'podman_failed' })
    fake.reply('ps', { stdout: 'null' })
    expect(await containers.running()).toEqual([])
    listed({ ...entry('x', 'd1'), Labels: null })
    expect(await containers.sweep(new Set())).toBe(0)
  })
})

describe('browserLimit', () => {
  it('is min(8, (memory - 1 GiB) / 2 GiB), at least 1', () => {
    expect(browserLimit(17 * GiB)).toBe(8)
    expect(browserLimit(7 * GiB)).toBe(3)
    expect(browserLimit(3 * GiB)).toBe(1)
    expect(browserLimit(GiB)).toBe(1)
  })
})
