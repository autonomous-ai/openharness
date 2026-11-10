/**
 * The agent browser's image, built on this machine from the files in the CLI (assets.ts); there is no registry. Its
 * tag names those files' hash and the ISO week, so a new CLI or a new week builds a fresh image (and so a current
 * Chrome), in the background while the older image keeps serving.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserAssetsHash, browserContextFiles } from './assets.js'
import { PodmanError, type Podman } from './podman.js'

const BUILD_TIMEOUT_MS = 15 * 60_000
const FAILURE_LINES = 50
const REPOSITORY = 'harness-browser'

/** `harness-browser:<hash>-<ISO year>w<ISO week>`, the week two digits so tags sort. */
export function imageTag(hash: string, now: Date): string {
  // The ISO week's year is the year of its Thursday.
  const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3 - ((now.getUTCDay() + 6) % 7)))
  const year = thursday.getUTCFullYear()
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000))
  return `${REPOSITORY}:${hash}-${year}w${String(week).padStart(2, '0')}`
}

interface Image { name: string; created: number; containers: number }

/** This machine's harness-browser images, each by its tags. Podman names a locally built image `localhost/…`. */
async function listImages(podman: Podman): Promise<Image[]> {
  const { stdout } = await podman.run(['images', '--format', 'json', '--filter', `reference=localhost/${REPOSITORY}`])
  // An image whose tags were all removed has no Names.
  const rows = JSON.parse(stdout) as Array<{ Names?: string[]; Created: number; Containers: number }>
  return rows.flatMap(row => (row.Names ?? [])
    .map(name => name.replace(/^localhost\//, ''))
    .filter(name => name.startsWith(`${REPOSITORY}:`))
    .map(name => ({ name, created: row.Created, containers: row.Containers })))
}

/** A real context dir, never stdin: a Containerfile read from stdin has no context, and its COPY lines need the files. */
async function build(podman: Podman, tag: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-browser-build-'))
  try {
    for (const [name, content] of Object.entries(browserContextFiles())) await writeFile(join(dir, name), content)
    await podman.run(['build', '-t', tag, dir], { timeoutMs: BUILD_TIMEOUT_MS })
  } catch (error) {
    throw new PodmanError('image_failed', (error as Error).message.split('\n').slice(-FAILURE_LINES).join('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// One build at a time per Podman: a second browser starting while the image builds waits on the same build, and a
// build for a newer tag waits for the one in flight.
const inFlight = new WeakMap<Podman, { tag: string; done: Promise<void> }>()

function buildOnce(podman: Podman, tag: string, log: (line: string) => void): Promise<void> {
  const running = inFlight.get(podman)
  if (running?.tag === tag) return running.done
  const done = (running?.done.catch(() => {}) ?? Promise.resolve()).then(() => build(podman, tag))
  const entry = { tag, done }
  inFlight.set(podman, entry)
  // Registered before any caller's wait, so a caller that goes on to build again never finds this one.
  const clear = () => { if (inFlight.get(podman) === entry) inFlight.delete(podman) }
  done.then(clear, clear)
  // Pruned once per build, however many browsers waited on it. A failure is logged here, and also thrown to a
  // caller that has no older image to run.
  done.then(() => pruneImages(podman, tag)).catch((error: unknown) => log(`agent browser: image ${tag}: ${(error as Error).message}`))
  return done
}

/**
 * The tag to run: the current one when it exists; else the newest older image at once, while the current one builds
 * in the background; else the current one once built. Throws `image_failed` only when there is no image at all.
 */
export async function ensureImage(podman: Podman, now: Date, log: (line: string) => void): Promise<string> {
  const tag = imageTag(browserAssetsHash(), now)
  const images = await listImages(podman)
  if (images.some(image => image.name === tag)) return tag
  const older = images.sort((a, b) => b.created - a.created)[0]
  const built = buildOnce(podman, tag, log)
  if (!older) {
    await built
    return tag
  }
  // A failed background build never fails a browser: the older image serves until the next start tries again.
  built.catch(() => {})
  return older.name
}

/** Removes every harness-browser tag but `keep` that no container uses, so at most two images exist at a time. */
export async function pruneImages(podman: Podman, keep: string): Promise<void> {
  for (const image of await listImages(podman)) {
    if (image.name !== keep && image.containers === 0) await podman.run(['rmi', image.name])
  }
}
