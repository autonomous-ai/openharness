/** Immutable, operation-owned grid configuration. A replacement launch never
 * edits the directory still used by the live process it may later replace. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { env } from '../config/env.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { NativePaths, verifyNativePathFacts, type NativePathFact } from '../engines/kit/nativePaths.js'
import { HookPreparationHeld, hookPreparationRoutes, inspectHookFile, runHookPreparation, type HookPreparationAttempt, type HookPreparationProof } from '../engines/kit/nativeHookFiles.js'
import type { GridConfigFile, GridConfigLink } from './gridLaunchWire.js'

const identity = (info: NonNullable<ReturnType<typeof lstatSync>>) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function privateDirectory(path: string, create = true): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) {
    throw new HookPreparationHeld('the generated configuration directory is not private')
  }
}
async function syncDirectory(path: string, attempt: HookPreparationAttempt): Promise<void> {
  attempt.verify()
  const expected = identity(lstatSync(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (identity(fstatSync(fd)) !== expected) throw new HookPreparationHeld('the directory changed before confirmation')
    await attempt.flush(fd)
    if (identity(lstatSync(path)) !== expected) throw new HookPreparationHeld('the directory changed during confirmation')
  } finally { closeSync(fd) }
}

export async function publishGridConfigDir(key: string, inputFiles: readonly GridConfigFile[], inputLinks: readonly GridConfigLink[] = [], current = () => true): Promise<{ directory: string; proof: HookPreparationProof }> {
  const files = inputFiles.map(file => ({ ...file })), links = inputLinks.map(link => ({ ...link }))
  const names = [...files, ...links].map(item => item.name)
  if (!current() || !key || key.length > 4096 || !files.length || files.length > 16 || links.length > 8
    || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
    || files.some(file => typeof file.content !== 'string')
    || links.some(link => !isAbsolute(link.target) || link.target.includes('\0') || link.target.length > 4096)) {
    throw new HookPreparationHeld('the generated configuration request is invalid')
  }
  const content = JSON.stringify({ version: 1, key, files, links })
  if (Buffer.byteLength(content) > 1024 * 1024) throw new HookPreparationHeld('the generated configuration exceeds its limit')
  const digest = createHash('sha256').update(content).digest('hex')
  // A separate root keeps the legacy age-based prune away from active publications.
  const root = join(env.ADAPTER_DATA_DIR, 'grid-launch-config'), directory = join(root, digest)
  const manifest = join(root, `${digest}.json`), ready = join(directory, '.harness-config.json')
  const owner = `${manifest}.directory`, completion = `${manifest}.complete`
  const linkRecord = (link: GridConfigLink) => `${manifest}.${link.name}.link`
  const destinations = [manifest, owner, completion, ready, ...files.map(file => join(directory, file.name)), ...links.map(linkRecord)]
  const rootRoute = hookPreparationRoutes([manifest])
  const targetRoutes = links.length ? hookPreparationRoutes(links.map(link => join(link.target, '.harness-route'))) : undefined
  rootRoute.verify(); if (!current()) throw new HookPreparationHeld('the launch request changed')
  privateDirectory(root); rootRoute.verify()
  let proof: HookPreparationProof | undefined
  let linkFacts: NativePathFact[] = []
  await runHookPreparation(destinations, async attempt => {
    targetRoutes?.verify()
    const intended = inspectHookFile(manifest, 0o600)
    if (intended.content !== null && intended.content !== content) throw new HookPreparationHeld('the publication manifest changed')
    if (intended.content === null) {
      try { lstatSync(directory); throw new HookPreparationHeld('the generated directory has no ownership manifest') }
      catch (error) { if (!missing(error)) throw error }
    }
    await intended.replace(content, attempt, intended.content === null)
    attempt.verify()
    const ownership = inspectHookFile(owner, 0o600)
    if (ownership.content === null) {
      // Only a successful mkdir can assign this previously unowned directory.
      // A crash before its identity is durable leaves a visible hold, not an
      // invitation to adopt another directory at the same name.
      mkdirSync(directory, { mode: 0o700 })
    }
    privateDirectory(directory, false)
    const directoryPaths = new NativePaths(new NativeEvidenceBudget()), selectedDirectory = directoryPaths.resolveSync(directory)!
    const directoryFacts = directoryPaths.snapshot()
    attempt.observe(directory, () => verifyNativePathFacts(directoryFacts))
    const ownerBytes = JSON.stringify({ digest, directory: identity(selectedDirectory.info) })
    if (ownership.content !== null && ownership.content !== ownerBytes) throw new HookPreparationHeld('the publication directory identity changed')
    await ownership.replace(ownerBytes, attempt, ownership.content === null)
    const settled = inspectHookFile(completion, 0o600), completedBefore = inspectHookFile(ready, 0o600)
    if ((settled.content !== null && settled.content !== ownerBytes)
      || (completedBefore.content !== null && completedBefore.content !== digest)) throw new HookPreparationHeld('the publication completion changed')
    for (const file of files) {
      const target = join(directory, file.name), previous = inspectHookFile(target, 0o600)
      // Engines and people may have edited a prior publication. Preserve it.
      if (previous.content !== null && previous.content !== file.content) throw new HookPreparationHeld('a published configuration was changed')
      if (previous.content === null && (settled.content !== null || completedBefore.content !== null)) throw new HookPreparationHeld('a published configuration was removed')
      await previous.replace(file.content, attempt, previous.content === null)
    }
    for (const link of links) {
      const path = join(directory, link.name)
      const remembered = inspectHookFile(linkRecord(link), 0o600)
      if (remembered.content !== null) {
        const saved = JSON.parse(remembered.content)
        if (saved.version !== 1 || saved.target !== link.target || !Array.isArray(saved.facts)) throw new HookPreparationHeld('the borrowed native authority changed')
        verifyNativePathFacts(saved.facts)
      } else {
        if (settled.content !== null || completedBefore.content !== null) throw new HookPreparationHeld('the borrowed native authority is missing')
        try { lstatSync(path); throw new HookPreparationHeld('the native link has no retained authority') }
        catch (error) { if (!missing(error)) throw error }
      }
      const route = hookPreparationRoutes([join(link.target, '.harness-route')])
      targetRoutes?.verify(); route.verify(); attempt.verify()
      mkdirSync(link.target, { recursive: true, mode: 0o700 })
      route.verify()
      // The borrowed native directory may be an existing, verified alias.
      const targetPaths = new NativePaths(new NativeEvidenceBudget()), target = targetPaths.resolveSync(link.target)
      if (!target?.info.isDirectory()) throw new HookPreparationHeld('the borrowed native location is not a directory')
      const retained = targetPaths.snapshot()
      const authorityBytes = JSON.stringify({ version: 1, target: link.target, facts: retained })
      if (remembered.content !== null && remembered.content !== authorityBytes) throw new HookPreparationHeld('the borrowed native location changed')
      attempt.observe(link.target, () => verifyNativePathFacts(retained))
      await remembered.replace(authorityBytes, attempt, remembered.content === null)
      for (let parent = target.path, depth = 0; ; parent = dirname(parent)) {
        if (depth++ > 256) throw new HookPreparationHeld('the borrowed location exceeds its depth limit')
        verifyNativePathFacts(retained); route.verify(); await syncDirectory(parent, attempt)
        if (parent === '/') break
      }
      attempt.verify(); route.verify(); verifyNativePathFacts(retained)
      try {
        const existing = lstatSync(path)
        if (!existing.isSymbolicLink() || readlinkSync(path) !== link.target) throw new HookPreparationHeld('the borrowed native link changed')
      } catch (error) {
        if (!missing(error)) throw error
        if (settled.content !== null || completedBefore.content !== null) throw new HookPreparationHeld('a published native link was removed')
        symlinkSync(link.target, path, 'dir')
      }
      const selected = new NativePaths(new NativeEvidenceBudget())
      selected.resolveSync(path)
      const facts = selected.snapshot()
      linkFacts.push(...facts)
      attempt.observe(path, () => verifyNativePathFacts(facts))
      await syncDirectory(directory, attempt)
    }
    const completed = inspectHookFile(ready, 0o600)
    if (completed.content !== null && completed.content !== digest) throw new HookPreparationHeld('the publication completion changed')
    await completed.replace(digest, attempt, completed.content === null)
    await settled.replace(ownerBytes, attempt, settled.content === null)
  }, { current, identity: digest, retainConflicts: true, confirmed: result => { proof = result } })
  targetRoutes?.verify()
  for (const link of links) {
    const path = join(directory, link.name)
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== link.target) throw new HookPreparationHeld('the borrowed native link changed before acknowledgement')
    const saved = JSON.parse(inspectHookFile(linkRecord(link), 0o600).content ?? 'null')
    if (!saved || saved.version !== 1 || saved.target !== link.target || !Array.isArray(saved.facts)) throw new HookPreparationHeld('the borrowed native authority is missing')
    verifyNativePathFacts(saved.facts)
    linkFacts.push(...saved.facts)
  }
  // Joined publishers still retain their own link routes, not a peer's closure.
  for (const link of links) {
    const paths = new NativePaths(new NativeEvidenceBudget()); paths.resolveSync(join(directory, link.name)); linkFacts.push(...paths.snapshot())
  }
  const retained = new Map<string, NativePathFact>()
  for (const fact of [...linkFacts, ...targetRoutes?.facts ?? []]) {
    const previous = retained.get(fact.path)
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) throw new HookPreparationHeld('the borrowed native route changed before acknowledgement')
    retained.set(fact.path, fact)
  }
  linkFacts = [...retained.values()]
  const published = proof!
  const confirmed: HookPreparationProof = {
    files: published.files.map((file, index) => index === 0 ? { ...file, facts: [...file.facts, ...linkFacts] } : file),
    current: () => { try { targetRoutes?.verify(); if (linkFacts.length) verifyNativePathFacts(linkFacts); return published.current() } catch { return false } },
  }
  if (!current() || !confirmed.current()) throw new HookPreparationHeld('the generated configuration changed before acknowledgement')
  return { directory, proof: confirmed }
}
