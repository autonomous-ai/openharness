/** One credited page at a time; logical image size follows the legacy codec contract. */
import { SESSION_STORAGE_FRAME_BYTES, SESSION_STORAGE_PAGE_CHARS, SessionStorageUnavailable } from './sessionStorageWire.js'

interface Frame {
  protocol: 'session-storage-1'
  incarnation: string
  id: number
  kind: 'begin' | 'page' | 'end' | 'credit'
  sequence: number
  text?: string
}

export function sessionStorageFrames(incarnation: string,
  write: (frame: Frame) => Promise<void>, receive: (id: number, value: unknown) => void,
  failed: () => void) {
  let incoming: { id: number; sequence: number; pages: string[] } | undefined
  let outgoing: { id: number; sequence: number; credit: () => void; reject: (error: Error) => void } | undefined
  let closed = false
  let sending = false
  const fail = () => {
    if (closed) return
    closed = true
    outgoing?.reject(new SessionStorageUnavailable('disconnected'))
    outgoing = undefined
    incoming = undefined
    failed()
  }
  const sendFrame = (frame: Frame) => write(frame).catch(error => { fail(); throw error })
  return {
    close: fail,
    message(value: unknown): void {
      if (closed) return
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        const frame = value as Frame
        if (frame.protocol !== 'session-storage-1' || frame.incarnation !== incarnation
          || !Number.isSafeInteger(frame.id) || frame.id < 1 || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0
          || Buffer.byteLength(JSON.stringify(value)) > SESSION_STORAGE_FRAME_BYTES) throw new Error()
        if (frame.kind === 'credit') {
          if (!outgoing || outgoing.id !== frame.id || outgoing.sequence !== frame.sequence) throw new Error()
          const credit = outgoing.credit
          outgoing = undefined
          credit()
          return
        }
        if (frame.kind === 'begin') {
          if (incoming || frame.sequence !== 0 || frame.text !== undefined) throw new Error()
          incoming = { id: frame.id, sequence: 0, pages: [] }
        } else {
          if (!incoming || incoming.id !== frame.id || frame.sequence !== incoming.sequence + 1) throw new Error()
          incoming.sequence = frame.sequence
          if (frame.kind === 'page') {
            if (typeof frame.text !== 'string' || frame.text.length > SESSION_STORAGE_PAGE_CHARS) throw new Error()
            incoming.pages.push(frame.text)
          } else if (frame.kind === 'end') {
            if (frame.text !== undefined) throw new Error()
            const result: unknown = JSON.parse(incoming.pages.join(''))
            incoming = undefined
            receive(frame.id, result)
          } else throw new Error()
        }
        void sendFrame({ protocol: 'session-storage-1', incarnation, id: frame.id, kind: 'credit', sequence: frame.sequence }).catch(() => {})
      } catch { fail() }
    },
    async send(id: number, value: unknown): Promise<void> {
      if (closed || sending) throw new SessionStorageUnavailable('disconnected')
      sending = true
      try {
        const contents = JSON.stringify(value)
        const page = async (kind: Frame['kind'], sequence: number, text?: string) => {
          if (closed) throw new SessionStorageUnavailable('disconnected')
          await new Promise<void>((resolve, reject) => {
            outgoing = { id, sequence, credit: resolve, reject }
            void sendFrame({ protocol: 'session-storage-1', incarnation, id, kind, sequence, ...(text === undefined ? {} : { text }) }).catch(reject)
          })
        }
        await page('begin', 0)
        let sequence = 1
        for (let offset = 0; offset < contents.length; offset += SESSION_STORAGE_PAGE_CHARS) {
          await page('page', sequence++, contents.slice(offset, offset + SESSION_STORAGE_PAGE_CHARS))
        }
        await page('end', sequence)
      } finally { sending = false }
    },
  }
}
