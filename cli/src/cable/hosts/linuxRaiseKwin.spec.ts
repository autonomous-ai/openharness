import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { RECORDED_KWIN } from '../../testing/recordedKwin.js'
import { createKwinRaise, type KwinRaiseDeps } from './linuxRaiseKwin.js'

const BUS = 'unix:path=/run/user/1000/bus'
const DIR = '/run/user/1000/harness'
const DBUS_SEND = '/usr/bin/dbus-send'
const FILE = `${DIR}/raise-1.js`
const P6 = RECORDED_KWIN
const P5 = RECORDED_KWIN.plasma5

type Answer = { code: number | null; stdout: string }
type Call = { argv: string[]; timeoutMs: number; file: string | undefined }

/** The recorded argv as this runner gets it: dbus-send from PATH, then its arguments. */
const argv = (recorded: readonly string[]) => [DBUS_SEND, ...recorded.slice(1)]
const runAt = (path: string) => argv(P6.run.args).map((arg) => (arg === P6.run.args[4] ? path : arg))

/** A made-up login's KWin: each argv answers what [answers] gives for it (exit 1 with nothing for any other, as
 *  dbus-send does for an error reply), the files live in a map, and every call notes the script file as it stood. */
function kwin(answers: [readonly string[], Answer | (() => Promise<Answer>)][] = [], over: Partial<KwinRaiseDeps> = {}) {
  const files = new Map<string, string>()
  const written: { path: string; text: string }[] = []
  const calls: Call[] = []
  let names = 0
  const deps: KwinRaiseDeps = {
    run: async (file, args, timeoutMs) => {
      const call = [file, ...args]
      calls.push({ argv: call, timeoutMs, file: files.get(FILE) })
      const answer = answers.find(([recorded]) => JSON.stringify(recorded) === JSON.stringify(call))?.[1]
      return answer === undefined ? { code: 1, stdout: '' } : typeof answer === 'function' ? answer() : answer
    },
    onPath: (name) => (name === 'dbus-send' ? DBUS_SEND : null),
    dir: DIR,
    write: (path, text) => {
      files.set(path, text)
      written.push({ path, text })
    },
    remove: (path) => {
      files.delete(path)
    },
    name: () => String(++names),
    ...over,
  }
  return { deps, files, written, calls, backend: createKwinRaise(deps, BUS) }
}

const PLASMA_6: [readonly string[], Answer][] = [
  [argv(P6.loadScript.args), { code: 0, stdout: P6.loadScript.stdout }],
  [argv(P6.run.args), { code: 0, stdout: P6.run.stdout }],
  [argv(P6.unloadScript.args), { code: 0, stdout: P6.unloadScript.stdout }],
]
const PLASMA_5: [readonly string[], Answer][] = [
  [argv(P5.loadScript.args), { code: 0, stdout: P5.loadScript.stdout }],
  [argv(P5.run.args), { code: 0, stdout: P5.run.stdout }],
  [argv(P5.unloadScript.args), { code: 0, stdout: P5.unloadScript.stdout }],
]

type Window = { pid: number; resourceClass: string }

/** The written script run against a fake KWin `workspace` with Plasma 6's API (windowList, activeWindow) or Plasma 5's
 *  (clientList, activeClient), as RECORDED_KWIN.scriptApi names them: the window it made the active one, if any. */
function activated(text: string, windows: Window[], api: typeof P6.scriptApi | typeof P5.scriptApi): Window | null {
  const workspace: Record<string, unknown> = { [api.list]: () => windows, [api.active]: null }
  runInNewContext(text, { workspace })
  return workspace[api.active] as Window | null
}

describe('createKwinRaise', () => {
  it('writes the script that ran on Plasma 6, then loads, runs and unloads it over the bus, each call within 10 s', async () => {
    const { backend, calls, written, files } = kwin(PLASMA_6)
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(true)
    expect(written).toEqual([{ path: FILE, text: P6.raiseScript }])
    expect(calls.map(({ argv }) => argv)).toEqual([argv(P6.loadScript.args), argv(P6.run.args), argv(P6.unloadScript.args)])
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([10_000, 10_000, 10_000])
    // KWin reads the file at run, not at load: a load of a missing file answers an id as well.
    expect(calls.map(({ file }) => file)).toEqual([P6.raiseScript, P6.raiseScript, P6.raiseScript])
    expect(files.size).toBe(0)
  })

  it("runs Plasma 5's script at its own object once Plasma 6's is not there", async () => {
    const { backend, calls, files } = kwin(PLASMA_5)
    expect(await backend.raise({ pids: [4102], classes: ['foot'] })).toBe(true)
    expect(calls.map(({ argv }) => argv)).toEqual([
      argv(P5.loadScript.args), runAt('/Scripting/Script0'), argv(P5.run.args), argv(P5.unloadScript.args),
    ])
    expect(files.size).toBe(0)
  })

  it('reads the script id from the load, not 0 always', async () => {
    const { backend, calls } = kwin([
      [argv(P6.loadScript.args), { code: 0, stdout: P6.loadScript.stdout.replace('int32 0', 'int32 17') }],
      [runAt('/Scripting/Script17'), { code: 0, stdout: P6.run.stdout }],
    ])
    expect(await backend.raise({ pids: [3123], classes: [] })).toBe(true)
    expect(calls.map(({ argv }) => argv[4])).toEqual(['/Scripting', '/Scripting/Script17', '/Scripting'])
  })

  it('activates the first of the pids that owns a window over a nearer one that owns none, on Plasma 6 and 5', async () => {
    const { backend, written } = kwin(PLASMA_6)
    await backend.raise({ pids: [4242, 4100, 4000], classes: ['foot'] })
    const windows = [{ pid: 4000, resourceClass: 'foot' }, { pid: 4100, resourceClass: 'foot' }, { pid: 77, resourceClass: 'other' }]
    expect(activated(written[0].text, windows, P6.scriptApi)).toBe(windows[1])
    expect(activated(written[0].text, windows, P5.scriptApi)).toBe(windows[1])
  })

  it('activates a window by class, without case, when no pid owns one, on Plasma 6 and 5', async () => {
    const { backend, written } = kwin(PLASMA_6)
    await backend.raise({ pids: [4242], classes: ['org.wezfurlong.wezterm', 'Code'] })
    const windows = [{ pid: 77, resourceClass: 'foot' }, { pid: 88, resourceClass: 'code' }]
    expect(activated(written[0].text, windows, P6.scriptApi)).toBe(windows[1])
    expect(activated(written[0].text, windows, P5.scriptApi)).toBe(windows[1])
  })

  it('activates nothing when neither a pid nor a class matches', async () => {
    const { backend, written } = kwin(PLASMA_6)
    await backend.raise({ pids: [4242], classes: ['Code'] })
    const windows = [{ pid: 77, resourceClass: 'foot' }]
    expect(activated(written[0].text, windows, P6.scriptApi)).toBe(null)
    expect(activated(written[0].text, windows, P5.scriptApi)).toBe(null)
  })

  it('keeps a pid or class out of form out of the script', async () => {
    const { backend, written } = kwin(PLASMA_6)
    await backend.raise({
      pids: [0, 1, -5, 1.5, Number.NaN, 2 ** 60, 3123],
      classes: ['a"b', 'a\\b', 'a\nb', 'a b', '', 'x'.repeat(65), 'foot'],
    })
    expect(written[0].text).toBe(P6.raiseScript)
  })

  it('writes nothing and runs nothing when no pid or class is in form', async () => {
    const { backend, written, calls } = kwin(PLASMA_6)
    expect(await backend.raise({ pids: [0, -1], classes: ['a"b'] })).toBe(false)
    expect(written).toEqual([])
    expect(calls).toEqual([])
  })

  it.each([
    ['another transport', 'tcp:host=box,port=1'],
    ['a second address', `${BUS};unix:path=/tmp/other`],
    ['a guid left on', `${BUS},guid=0123`],
  ])('writes nothing and runs nothing on a bus out of form: %s', async (_, bus) => {
    const { deps, written, calls } = kwin(PLASMA_6)
    expect(await createKwinRaise(deps, bus).raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(written).toEqual([])
    expect(calls).toEqual([])
  })

  it('takes a class only in the form every raise takes: one that starts with a letter or a digit', async () => {
    const { backend, written, calls } = kwin(PLASMA_6)
    expect(await backend.raise({ pids: [], classes: ['.foot', '-foot', '_foot'] })).toBe(false)
    expect(written).toEqual([])
    expect(calls).toEqual([])
  })

  it('writes nothing and runs nothing with no dbus-send on PATH', async () => {
    const { backend, written, calls } = kwin(PLASMA_6, { onPath: () => null })
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(written).toEqual([])
    expect(calls).toEqual([])
  })

  it.each([
    ['no KWin on the bus', { code: P6.noKwin.code, stdout: '' }],
    ['a load that does not answer, or prints over the runner\'s buffer', { code: null, stdout: '' }],
  ])('answers false after %s, with nothing to unload and the file gone', async (_, load) => {
    const { backend, calls, files } = kwin([[argv(P6.loadScript.args), load], ...PLASMA_6.slice(1)])
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(calls.map(({ argv }) => argv)).toEqual([argv(P6.loadScript.args)])
    expect(files.size).toBe(0)
  })

  it.each([
    ['no id', 'method return time=1 sender=:1.0 -> destination=:1.10 serial=81 reply_serial=2\n'],
    ['an id out of form', P6.loadScript.stdout.replace('int32 0', 'int32 -1')],
  ])('answers false when the load prints %s, runs nothing, unloads the script and removes the file', async (_, stdout) => {
    const { backend, calls, files } = kwin([[argv(P6.loadScript.args), { code: 0, stdout }], ...PLASMA_6.slice(1)])
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(calls.map(({ argv }) => argv)).toEqual([argv(P6.loadScript.args), argv(P6.unloadScript.args)])
    expect(files.size).toBe(0)
  })

  it('answers false when the run fails at both objects, and still unloads the script and removes the file', async () => {
    const { backend, calls, files } = kwin([PLASMA_6[0], PLASMA_6[2]])
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(calls.map(({ argv }) => argv)).toEqual([
      argv(P6.loadScript.args), argv(P6.run.args), runAt('/0'), argv(P6.unloadScript.args),
    ])
    expect(files.size).toBe(0)
  })

  it("does not try Plasma 5's object after a run that did not answer", async () => {
    const { backend, calls, files } = kwin([PLASMA_6[0], [argv(P6.run.args), { code: null, stdout: '' }], PLASMA_6[2]])
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(false)
    expect(calls.map(({ argv }) => argv)).toEqual([argv(P6.loadScript.args), argv(P6.run.args), argv(P6.unloadScript.args)])
    expect(files.size).toBe(0)
  })

  it("answers the run's outcome whatever the unload answers", async () => {
    const { backend, files } = kwin([PLASMA_6[0], PLASMA_6[1], [argv(P6.unloadScript.args), { code: 1, stdout: '' }]])
    expect(await backend.raise({ pids: [3123], classes: ['foot'] })).toBe(true)
    expect(files.size).toBe(0)
  })

  it('answers false and leaves no file when the runner throws, and never throws itself', async () => {
    const thrown = async (): Promise<Answer> => {
      throw new Error('spawn failed')
    }
    const { backend, files } = kwin([[argv(P6.loadScript.args), thrown]])
    await expect(backend.raise({ pids: [3123], classes: ['foot'] })).resolves.toBe(false)
    expect(files.size).toBe(0)

    const run = kwin([PLASMA_6[0], [argv(P6.run.args), thrown], [runAt('/0'), thrown], [argv(P6.unloadScript.args), thrown]])
    await expect(run.backend.raise({ pids: [3123], classes: ['foot'] })).resolves.toBe(false)
    expect(run.files.size).toBe(0)
  })

  it('answers false and leaves no file when the write throws', async () => {
    const files = new Map<string, string>()
    const { backend, calls } = kwin(PLASMA_6, {
      write: (path) => {
        files.set(path, 'var pids = [')
        throw new Error('ENOSPC')
      },
      remove: (path) => {
        files.delete(path)
      },
    })
    await expect(backend.raise({ pids: [3123], classes: ['foot'] })).resolves.toBe(false)
    expect(calls).toEqual([])
    expect(files.size).toBe(0)
  })

  it('uses a file and a script name of its own for each of two raises at once', async () => {
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    const { backend, files, calls } = kwin([
      [argv(P6.loadScript.args), async () => {
        await held
        return { code: 0, stdout: P6.loadScript.stdout }
      }],
      [[DBUS_SEND, ...P6.loadScript.args.slice(1, 6), `string:${DIR}/raise-2.js`, 'string:harness-raise-2'], async () => {
        await held
        return { code: 0, stdout: P6.loadScript.stdout.replace('int32 0', 'int32 1') }
      }],
      [argv(P6.run.args), { code: 0, stdout: P6.run.stdout }],
      [runAt('/Scripting/Script1'), { code: 0, stdout: P6.run.stdout }],
    ])
    const both = Promise.all([
      backend.raise({ pids: [3123], classes: [] }),
      backend.raise({ pids: [3134], classes: [] }),
    ])
    await vi.waitFor(() => expect(calls.length).toBe(2))
    expect([...files.keys()]).toEqual([FILE, `${DIR}/raise-2.js`])
    release()
    expect(await both).toEqual([true, true])
    expect(calls.filter(({ argv }) => argv[5] === 'org.kde.kwin.Scripting.unloadScript').map(({ argv }) => argv[6]))
      .toEqual(expect.arrayContaining(['string:harness-raise-1', 'string:harness-raise-2']))
    expect(files.size).toBe(0)
  })
})
