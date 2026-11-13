/**
 * A Super Tab chat file from the native desktop, on its way to the backend. The app's REST client talks only to this
 * daemon over localhost and holds no account token (the browser build holds its own), so the daemon passes this one
 * upload on with the account's token, never through the relay.
 *
 * This side runs in the core's process, behind the Swarm's door, and takes the upload in: multipart only, one byte past
 * the cap ends it, and one that stops moving ends too. It is written to a file of its own in the daemon's uploads
 * folder, and the gateway sends that file to the backend (gateway/upload.ts): the core calls no other host (the core
 * audit of 2026-11-12). Until then the core streamed it to the backend itself, with the account's token. The
 * backend's answer (its status and its small JSON body) is handed back as it came, and the file goes with it.
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, readdirSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Transform, type Writable } from 'node:stream'
import type { UploadAnswer } from '../core/api.js'
import { prepareAgentTmp } from './agentTmp.js'
import { MULTIPART_TYPE, UPLOAD_IDLE_MS } from './gatewayWire.js'

/** The most one file sent by this multipart route may be. A larger one, up to 256 MB, goes straight to storage by a signed
 *  link (superTabs/attach.ts): production sits behind Cloudflare, which may refuse a request body over 100 MB. */
export const MAX_FORM_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** The form's file and its multipart framing, a few hundred bytes. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = MAX_FORM_ATTACHMENT_BYTES + 1024 * 1024
/** What every upload under way may keep on disk together, until the gateway has sent it: six of the largest at once, any
 *  number of small ones. One more is told to try again, never queued on disk without end. */
export const ATTACHMENTS_KEPT_MAX_BYTES = 64 * 1024 * 1024
/** Said of a form past that cap. Every client sends a file over 10 MB by the link, and an older one refused it before
 *  sending, so only a client in error meets this. */
const TOO_LARGE = 'A file can be at most 10 MB.'

class TooLarge extends Error {}
class TooMany extends Error {}

export interface AttachmentProxyDeps {
  /** The gateway's send of the file to the backend (`GatewayOps.backendUpload`). */
  upload: (request: { file: string; path: string; contentType: string }) => Promise<UploadAnswer>
  /** The daemon's uploads folder (lib/gatewayWire.ts `uploadsFolder`). */
  folder: string
  maxBytes?: number
  keptMaxBytes?: number
  idleMs?: number
  log?: (line: string) => void
  /** Where a file is written: swapped in a spec for a disk that fills. */
  keep?: (file: string) => Writable
}

/** Folders whose files a process before this one may have left: one cut off mid-upload is deleted by the next. */
const swept = new Set<string>()
/** What this process keeps on disk for uploads under way, by folder. */
const kept = new Map<string, number>()

/** What a gateway's refusal tells the desktop: as the core said it when it sent the file itself, and its own words for
 *  a gateway that is not there. */
const REFUSALS: Record<Exclude<UploadAnswer, { status: number }>['error'], [number, string, string]> = {
  NOT_SIGNED_IN: [401, 'NOT_SIGNED_IN', 'Sign in on this computer to attach files.'],
  BACKEND_UNREACHABLE: [502, 'BACKEND_UNREACHABLE', 'Could not reach the Harness backend. Check the connection and try again.'],
  BACKEND_TIMEOUT: [504, 'BACKEND_TIMEOUT', 'The Harness backend did not finish taking the file. Try again.'],
  // The core asked for what the gateway does not send: never the desktop's to fix by sending it otherwise.
  INVALID_UPLOAD: [500, 'ATTACHMENT_NOT_SENT', 'Harness on this computer could not send this file. Try again, or tell the Harness team.'],
  GATEWAY_UNAVAILABLE: [503, 'GATEWAY_UNAVAILABLE', 'Harness on this computer is restarting what sends files. Try again in a moment.'],
}

/** Best effort: what a process before this one left goes, once. One it cannot remove is said, and the upload goes on. */
function sweep(folder: string, log: (line: string) => void): void {
  if (swept.has(folder)) return
  swept.add(folder)
  let names: string[] = []
  try { names = readdirSync(folder) } catch (error) { log(`[attachments] the uploads folder could not be read: ${(error as NodeJS.ErrnoException).code ?? error}`) }
  for (const name of names) {
    try { rmSync(join(folder, name), { recursive: true, force: true }) } catch (error) {
      log(`[attachments] a file left in the uploads folder could not be removed: ${(error as NodeJS.ErrnoException).code ?? error}`)
    }
  }
}

type Taken = 'kept' | 'too-large' | 'too-many' | 'stalled' | 'not-kept' | 'gone'

export async function forwardAttachmentUpload(req: IncomingMessage, res: ServerResponse, path: string, deps: AttachmentProxyDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const answer = (status: number, code: string, message: string) => {
    if (res.headersSent || res.destroyed) { res.destroy(); return }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: { code, message } }))
  }
  const max = deps.maxBytes ?? ATTACHMENT_UPLOAD_MAX_BYTES
  const keptMax = deps.keptMaxBytes ?? ATTACHMENTS_KEPT_MAX_BYTES
  const type = req.headers['content-type'] ?? ''
  if (!MULTIPART_TYPE.test(type)) {
    req.resume()
    return answer(400, 'INVALID_ATTACHMENT', 'Send the file as multipart/form-data.')
  }
  // A declared length already over the cap is refused before a byte is read.
  if (Number(req.headers['content-length'] ?? 0) > max) {
    req.resume()
    return answer(413, 'ATTACHMENT_TOO_LARGE', TOO_LARGE)
  }
  // This account's alone: made 0700, and refused when it is a link or another account's folder.
  if (!prepareAgentTmp(deps.folder)) {
    req.resume()
    log('[attachments] the uploads folder is not this account\'s alone: the file was refused')
    return answer(500, 'ATTACHMENT_FOLDER', 'This computer could not keep the file to send it. Try again.')
  }
  sweep(deps.folder, log)
  const file = join(deps.folder, randomUUID())
  let seen = 0
  const release = () => { kept.set(deps.folder, (kept.get(deps.folder) ?? 0) - seen) }
  try {
    const taken = await new Promise<Taken>((resolve) => {
      let quiet: NodeJS.Timeout | undefined
      const settle = (outcome: Taken) => {
        clearTimeout(quiet)
        resolve(outcome)
      }
      // A body that is refused is still read to its end, and dropped: the sender then hears the answer, not a reset.
      const drop = () => { req.unpipe(counter); req.resume() }
      const moved = () => {
        clearTimeout(quiet)
        quiet = setTimeout(() => { drop(); counter.destroy(); out.destroy(); settle('stalled') }, deps.idleMs ?? UPLOAD_IDLE_MS)
      }
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        seen += chunk.byteLength
        kept.set(deps.folder, (kept.get(deps.folder) ?? 0) + chunk.byteLength)
        moved()
        done(seen > max ? new TooLarge() : (kept.get(deps.folder) ?? 0) > keptMax ? new TooMany() : null, chunk)
      } })
      const out: Writable = (deps.keep ?? ((path: string) => createWriteStream(path, { flags: 'wx', mode: 0o600 })))(file)
      counter.on('error', (error) => { drop(); out.destroy(); settle(error instanceof TooLarge ? 'too-large' : 'too-many') })
      out.on('error', (error: Error) => {
        drop()
        log(`[attachments] the file could not be kept: ${(error as NodeJS.ErrnoException).code ?? error.message}`)
        settle('not-kept')
      })
      out.on('finish', () => settle('kept'))
      // The sender went away before its last byte: nobody is left to answer.
      req.on('close', () => { if (!req.complete) { counter.destroy(); out.destroy(); settle('gone') } })
      moved()
      req.pipe(counter).pipe(out)
    })
    if (taken === 'too-large') return answer(413, 'ATTACHMENT_TOO_LARGE', TOO_LARGE)
    if (taken === 'too-many') {
      res.setHeader('Retry-After', '5')
      return answer(429, 'ATTACHMENTS_BUSY', 'Many files are being sent at once. Try again in a moment.')
    }
    if (taken === 'stalled') return answer(408, 'ATTACHMENT_STALLED', 'The file stopped arriving. Try again.')
    if (taken === 'not-kept') return answer(507, 'ATTACHMENT_NOT_KEPT', 'This computer could not keep the file to send it: its disk may be full.')
    if (taken === 'gone') return
    const sent = await deps.upload({ file, path, contentType: type })
    if ('error' in sent) return answer(...REFUSALS[sent.error])
    res.writeHead(sent.status, { 'Content-Type': sent.contentType })
    res.end(sent.body)
  } finally {
    release()
    try { rmSync(file, { force: true }) } catch (error) {
      log(`[attachments] a sent file could not be removed: ${(error as NodeJS.ErrnoException).code ?? error}`)
    }
  }
}
