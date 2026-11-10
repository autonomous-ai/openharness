import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserAssetsHash, browserContextFiles } from './assets.js'
import { fakePodman, type FakePodman } from './fakePodman.js'
import { ensureImage, imageTag, pruneImages } from './image.js'
import { createPodman, PodmanError, type Podman } from './podman.js'

// The login shell is never started in a spec.
vi.mock('../../lib/loginShellEnv.js', () => ({ oneShotParentEnv: () => ({ ...process.env }) }))

const NOW = new Date('2026-11-10T12:00:00Z')
const TAG = `harness-browser:${browserAssetsHash()}-2026w46`
const OLDER = 'harness-browser:0123456789ab-2026w45'
const LIST = 'images --format json --filter reference=localhost/harness-browser'
const images = (...list: Array<{ name: string; created: number; containers?: number }>) => JSON.stringify(
  list.map(image => ({ Names: [`localhost/${image.name}`], Created: image.created, Containers: image.containers ?? 0 })),
)

let fake: FakePodman
let podman: Podman
// What the build's context dir held when `podman build` was called, and that dir.
let context: { dir: string; files: Record<string, string> } | null
// Every call made, so a spec whose build runs in the background can wait for the last of them.
let runs: Promise<unknown>[]
// When each build started and ended, to see that two never overlap.
let spans: Array<{ start: number; end: number }>
// Every call the code made, and whether it has ended. A spec waits on these, never on a clock: the fake is a Node
// process per call, and under load one took over a second to start (a 1 s waitFor failed 2 of 5 runs).
let made: Array<{ command: string; ended: boolean }>
let waiters: Array<() => void>
const changed = () => { for (const wake of waiters.splice(0)) wake() }
/** Resolves once `check` holds, looked at again after every call starts or ends and every log line. */
function until(check: () => boolean): Promise<void> {
  return check() ? Promise.resolve() : new Promise(done => waiters.push(() => void until(check).then(done)))
}
const started = (command: string) => made.filter(call => call.command === command).length
const ended = (command: string) => made.filter(call => call.command === command && call.ended).length
beforeEach(() => {
  fake = fakePodman()
  context = null
  runs = []
  spans = []
  made = []
  waiters = []
  const real = createPodman({ resolve: async () => fake.path })
  podman = {
    ...real,
    run(args, opts) {
      if (args[0] === 'build') {
        const dir = args.at(-1)!
        context = { dir, files: Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')])) }
      }
      const run = real.run(args, opts)
      runs.push(run)
      const call = { command: args[0]!, ended: false }
      made.push(call)
      changed()
      void run.finally(() => { call.ended = true; changed() }).catch(() => {})
      if (args[0] === 'build') {
        const span = { start: Date.now(), end: Infinity }
        spans.push(span)
        void run.finally(() => { span.end = Date.now() }).catch(() => {})
      }
      return run
    },
  }
})
afterEach(() => { fake.remove() })

const builds = () => fake.calls().filter(call => call.args[0] === 'build')
const removals = () => fake.calls().filter(call => call.args[0] === 'rmi').map(call => call.args)
// The background work after the last call: removing the context dir, then the log or the prune that follows.
async function settled() {
  await Promise.allSettled(runs)
  await new Promise(done => setImmediate(done))
}

describe('imageTag', () => {
  it('tag carries the hash and the ISO week', () => {
    expect(imageTag('abc', NOW)).toBe('harness-browser:abc-2026w46')
    // 2027-01-01 is a Friday: ISO week 53 of 2026. 2026-12-28 is the Monday of that week, 2025-12-29 of 2026's first.
    expect(imageTag('abc', new Date('2027-01-01T00:00:00Z'))).toBe('harness-browser:abc-2026w53')
    expect(imageTag('abc', new Date('2025-12-29T00:00:00Z'))).toBe('harness-browser:abc-2026w01')
  })
})

describe('ensureImage', () => {
  it('builds from a temp context dir, not stdin', async () => {
    fake.reply(LIST, { stdout: '[]' })
    await expect(ensureImage(podman, NOW, () => {})).resolves.toBe(TAG)
    expect(builds()).toHaveLength(1)
    expect(builds()[0]).toMatchObject({ args: ['build', '-t', TAG, context!.dir], stdin: '' })
    expect(context!.files).toEqual(browserContextFiles())
  })

  it('returns the current tag without building when it exists', async () => {
    fake.reply(LIST, { stdout: images({ name: OLDER, created: 1 }, { name: TAG, created: 2 }) })
    await expect(ensureImage(podman, NOW, () => {})).resolves.toBe(TAG)
    expect(builds()).toHaveLength(0)
  })

  it('with an older image present, returns it at once and builds the new tag in the background', async () => {
    fake.reply(LIST, { stdout: images({ name: 'harness-browser:aaaaaaaaaaaa-2026w44', created: 1 }, { name: OLDER, created: 2 }) })
    fake.reply('build', { hangMs: 1000 })
    await expect(ensureImage(podman, NOW, () => {})).resolves.toBe(OLDER)
    await until(() => started('build') === 1)
    // Answered while the build still runs: its context dir is still there and nothing is pruned yet.
    expect(existsSync(context!.dir)).toBe(true)
    expect(started('rmi')).toBe(0)
    await until(() => ended('rmi') === 2)
    expect(removals()).toHaveLength(2)
    await settled()
  })

  it('after a background build succeeds, prune removes older harness-browser tags no container uses', async () => {
    fake.reply(LIST, { stdout: images({ name: 'harness-browser:aaaaaaaaaaaa-2026w44', created: 1 }, { name: OLDER, created: 2, containers: 1 }) })
    const log = vi.fn()
    await expect(ensureImage(podman, NOW, log)).resolves.toBe(OLDER)
    await until(() => ended('rmi') === 1)
    await settled()
    expect(removals()).toEqual([['rmi', 'harness-browser:aaaaaaaaaaaa-2026w44']])
    expect(log).not.toHaveBeenCalled()
  })

  it('a failed background build is logged and the next call still returns the older image', async () => {
    fake.reply(LIST, { stdout: images({ name: OLDER, created: 2 }) })
    fake.reply('build', { code: 1, stderr: 'no network' })
    const log = vi.fn(changed)
    await expect(ensureImage(podman, NOW, log)).resolves.toBe(OLDER)
    await until(() => log.mock.calls.length === 1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no network'))
    await expect(ensureImage(podman, NOW, log)).resolves.toBe(OLDER)
    await until(() => log.mock.calls.length === 2)
    expect(removals()).toEqual([])
  })

  it('with no image at all, a failed build throws image_failed with the last 50 lines', async () => {
    fake.reply(LIST, { stdout: '[]' })
    fake.reply('build', { code: 1, stderr: Array.from({ length: 80 }, (_, n) => `line ${n + 1}`).join('\n') })
    const error = await ensureImage(podman, NOW, () => {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PodmanError)
    expect((error as PodmanError).state).toBe('image_failed')
    expect((error as PodmanError).message).toBe(Array.from({ length: 50 }, (_, n) => `line ${n + 31}`).join('\n'))
  })

  it('a failed build logs and throws its own output, where apt says why, not only Podman\'s step line', async () => {
    // As two macOS runs failed: apt's error is the RUN step's output, on stdout; stderr has only the failed step.
    const apt = [...Array.from({ length: 60 }, (_, n) => `Get:${n + 1} http://deb.debian.org/debian bookworm InRelease`), 'E: Unable to locate package chromium']
    const step = 'Error: building at STEP "RUN apt-get install -y chromium": while running runtime: exit status 100'
    fake.reply(LIST, { stdout: '[]' })
    fake.reply('build', { code: 100, stdout: apt.join('\n'), stderr: step })
    const log = vi.fn()
    const error = await ensureImage(podman, NOW, log).catch((e: unknown) => e)
    expect((error as PodmanError).state).toBe('image_failed')
    const lines = (error as PodmanError).message.split('\n')
    expect(lines).toHaveLength(50)
    expect(lines.slice(-2)).toEqual(['E: Unable to locate package chromium', step])
    await settled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('E: Unable to locate package chromium'))
  })

  it('one build at a time', async () => {
    fake.reply(LIST, { stdout: '[]' })
    fake.reply('build', { hangMs: 200 })
    await expect(Promise.all([ensureImage(podman, NOW, () => {}), ensureImage(podman, NOW, () => {})])).resolves.toEqual([TAG, TAG])
    expect(builds()).toHaveLength(1)
  })

  it('a build for a new week waits for the one in flight', async () => {
    fake.reply(LIST, { stdout: '[]' })
    fake.reply('build', { hangMs: 200 })
    const nextWeek = new Date('2026-11-17T12:00:00Z')
    const first = ensureImage(podman, NOW, () => {})
    await until(() => started('build') === 1)
    const tags = await Promise.all([first, ensureImage(podman, nextWeek, () => {})])
    expect(tags).toEqual([TAG, imageTag(browserAssetsHash(), nextWeek)])
    expect(builds().map(call => call.args[2])).toEqual(tags)
    expect(spans).toHaveLength(2)
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end)
  })

  it('a build for a new week still runs when the one in flight fails', async () => {
    fake.reply(LIST, { stdout: '[]' })
    fake.reply(`build -t ${TAG}`, { code: 1, stderr: 'broken', hangMs: 200 })
    const nextWeek = new Date('2026-11-17T12:00:00Z')
    const failing = ensureImage(podman, NOW, () => {})
    await until(() => started('build') === 1)
    const [first, second] = await Promise.allSettled([failing, ensureImage(podman, nextWeek, () => {})])
    expect(first).toMatchObject({ status: 'rejected', reason: { state: 'image_failed' } })
    expect(second).toEqual({ status: 'fulfilled', value: imageTag(browserAssetsHash(), nextWeek) })
  })

  it('temp dir removed after success and failure', async () => {
    fake.reply(LIST, { stdout: '[]' })
    await ensureImage(podman, NOW, () => {})
    expect(existsSync(context!.dir)).toBe(false)
    fake.reply('build', { code: 1, stderr: 'broken' })
    await expect(ensureImage(podman, NOW, () => {})).rejects.toThrow('broken')
    expect(existsSync(context!.dir)).toBe(false)
  })

  it('a listing Podman cannot answer fails the call', async () => {
    fake.reply(LIST, { code: 125, stderr: 'cannot connect' })
    await expect(ensureImage(podman, NOW, () => {})).rejects.toThrow('cannot connect')
    expect(builds()).toHaveLength(0)
  })
})

describe('pruneImages', () => {
  it('keeps the given tag and every image a container uses', async () => {
    const untagged = { Created: 0, Containers: 0 }
    const other = { Names: ['localhost/harness-browser-dev:x'], Created: 0, Containers: 0 }
    const list = [...JSON.parse(images({ name: 'harness-browser:a-2026w40', created: 1 }, { name: OLDER, created: 2, containers: 2 }, { name: TAG, created: 3 })), untagged, other]
    fake.reply(LIST, { stdout: JSON.stringify(list) })
    await pruneImages(podman, TAG)
    expect(removals()).toEqual([['rmi', 'harness-browser:a-2026w40']])
  })
})
