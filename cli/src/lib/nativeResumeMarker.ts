/** The existing .resume file reserves one saved visit. It never proves that a
 * process did or did not launch. All calls run under the saved Store's lock. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { hookPreparationRoutes, inspectHookFile } from '../engines/kit/nativeHookFiles.js'
import { inspectNativeControlFile } from './nativeControlFile.js'
import { AtomicWriteUnconfirmed, atomicWriteJson } from './registry.js'
import { creationFingerprint } from './agentCreationReceipt.js'
import { parseNativeArchiveLink, type NativeArchiveLink } from './nativeArchive.js'

interface Authority { verify(): void; current(): void }
const same = (a: unknown, b: unknown) => creationFingerprint(a) === creationFingerprint(b)
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}`

function markerLink(contents: string): NativeArchiveLink | null {
  const raw: unknown = JSON.parse(contents)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== 'nativeArchive,version') return null
  const value = raw as { version?: unknown; nativeArchive?: unknown }
  return value.version === 1 ? parseNativeArchiveLink(value.nativeArchive) : null
}

function parentProof(directory: string, file: string) {
  const read = () => {
    const info = lstatSync(directory, { bigint: true })
    if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n
      || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw Error('The native Resume directory is unavailable.')
    return identity(info)
  }
  const original = read(), route = hookPreparationRoutes([file])
  return {
    verify() {
      route.verify()
      if (read() !== original) throw Error('The original native Resume directory changed.')
    },
    verifyDescriptor(fd: number) {
      if (identity(fstatSync(fd, { bigint: true })) !== original) throw Error('The original native Resume directory descriptor changed.')
    },
  }
}

type DirectoryProof = ReturnType<typeof parentProof>

function confirmAbsence(file: string, directory: string, parent: DirectoryProof, authority: Authority) {
  const missing = inspectHookFile(file, 0o600)
  if (missing.content !== null) throw Error('The native Resume marker reappeared during cleanup.')
  const verify = () => { authority.verify(); parent.verify(); missing.verify(); authority.current() }
  verify()
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    parent.verifyDescriptor(fd)
    verify(); fsyncSync(fd)
    parent.verifyDescriptor(fd)
    verify()
  } finally { closeSync(fd) }
  verify()
}

export class NativeResumeMarkers {
  private readonly uncertain = new Map<string, { link: NativeArchiveLink; directory: DirectoryProof;
    kind: 'publish' | 'remove'; verifyPublished?: () => void }>()
  constructor(private readonly directory: string) {}

  reserve(input: NativeArchiveLink, authority: Authority): { verify(): void } {
    const link = parseNativeArchiveLink(input)
    if (!link) throw Error('The original native Resume identity is unavailable.')
    const file = join(this.directory, `${link.agentId}.resume`), prior = this.uncertain.get(link.agentId)
    if (prior && (prior.kind !== 'publish' || !same(prior.link, link))) throw Error('The original native Resume marker needs cleanup confirmation.')
    if (!prior && this.uncertain.size >= 256) throw Error('Waiting for native Resume marker confirmation capacity.')
    const directory = prior?.directory ?? parentProof(this.directory, file)
    const { verify: verifyAuthority, current } = authority
    const before = inspectHookFile(file, 0o600)
    const owner = () => { verifyAuthority(); directory.verify(); current() }
    const verifyBefore = () => { owner(); before.verify(); prior?.verifyPublished?.(); current() }
    let publication: (() => void) | undefined = prior?.verifyPublished
    if (before.content !== null) {
      if (!same(markerLink(before.content), link)) throw Error('A different Resume reservation must finish first.')
      const retained = inspectNativeControlFile(file, this.directory)
      retained.confirm(verifyBefore)
      publication = prior?.verifyPublished ?? before.verify
    } else {
      if (prior) throw Error('The original native Resume publication disappeared.')
      try {
        atomicWriteJson(file, { version: 1, nativeArchive: link }, false, verifyBefore, (verifyPublished, contents) => {
          const retained = inspectNativeControlFile(file, this.directory)
          if (retained.content !== contents) throw Error('The published native Resume marker changed.')
          retained.confirm(() => { verifyPublished(); owner(); current() })
          publication = () => { verifyPublished(); directory.verify(); retained.verify() }
        })
      } catch (error) {
        if (error instanceof AtomicWriteUnconfirmed) this.uncertain.set(link.agentId, { kind: 'publish', link,
          directory, verifyPublished: error.verifyPublished ?? (() => { throw Error('The original native Resume publisher is unavailable.') }) })
        throw error
      }
    }
    if (!publication) throw Error('The original native Resume publisher is unavailable.')
    this.uncertain.set(link.agentId, { kind: 'publish', link, directory, verifyPublished: publication })
    const retained = inspectNativeControlFile(file, this.directory), published = publication
    const verify = () => { verifyAuthority(); published(); retained.verify(); directory.verify(); current() }
    verify()
    this.uncertain.delete(link.agentId)
    return { verify }
  }

  finish(input: NativeArchiveLink, authority: Authority): void {
    const link = parseNativeArchiveLink(input)
    if (!link) throw Error('The original native Resume identity is unavailable.')
    const file = join(this.directory, `${link.agentId}.resume`), prior = this.uncertain.get(link.agentId)
    if (prior && !same(prior.link, link)) throw Error('A different native Resume marker needs confirmation.')
    if (!prior && this.uncertain.size >= 256) throw Error('Waiting for native Resume marker confirmation capacity.')
    const directory = prior?.directory ?? parentProof(this.directory, file)
    const { verify: verifyAuthority, current } = authority
    directory.verify()
    const before = inspectHookFile(file, 0o600)
    if (before.content !== null) {
      if (prior?.kind === 'remove' && !prior.verifyPublished || !same(markerLink(before.content), link)) throw Error('A different Resume reservation must finish first.')
      const retained = inspectNativeControlFile(file, this.directory)
      const published = prior?.verifyPublished ?? (() => { before.verify(); retained.verify() })
      const verify = () => { verifyAuthority(); directory.verify(); published(); before.verify(); retained.verify(); current() }
      retained.confirm(verify)
      verify()
      // An unlink can take effect before reporting an error. Keep its original
      // parent and marker first; an unchanged failed unlink can still be retried.
      this.uncertain.set(link.agentId, { kind: 'remove', link, directory, verifyPublished: published })
      unlinkSync(file)
    }
    // Missing is an idempotent metadata outcome only under the independent
    // receipt/archive authority. Retain the first parent after an uncertain unlink.
    this.uncertain.set(link.agentId, { kind: 'remove', link, directory })
    confirmAbsence(file, this.directory, directory, { verify: verifyAuthority, current })
    this.uncertain.delete(link.agentId)
  }
}
