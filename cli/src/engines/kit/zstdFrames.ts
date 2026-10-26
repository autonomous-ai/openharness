/** Check complete zstd frame boundaries while the native decoder checks their contents.
 * Node 22.23's decoder silently accepts a truncated final block, even with finishFlush=end.
 * Publishing its partial output would lose history. This pass retains at most a frame header.
 * Format: https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md */
import { Transform } from 'node:stream'

export function completeZstdFrames(): Transform {
  type State = 'magic' | 'descriptor' | 'header' | 'block' | 'payload' | 'checksum' | 'skipSize' | 'skip'
  let state: State = 'magic', need = 4, used = 0, frames = 0, checksum = false, last = false
  const field = Buffer.alloc(14)
  const next = (value: State, bytes: number) => { state = value; need = bytes; used = 0 }
  const boundary = () => { frames++; next('magic', 4) }
  const advance = () => {
    switch (state) {
      case 'magic': {
        const magic = field.readUInt32LE(0)
        if (magic === 0xfd2fb528) next('descriptor', 1)
        else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) next('skipSize', 4)
        else throw new Error('Invalid zstd frame')
        break
      }
      case 'descriptor': {
        const descriptor = field[0], single = (descriptor & 32) !== 0, size = descriptor >>> 6
        if (descriptor & 8) throw new Error('Reserved zstd frame bit')
        checksum = (descriptor & 4) !== 0
        next('header', (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + [single ? 1 : 0, 2, 4, 8][size])
        break
      }
      case 'header': next('block', 3); break
      case 'block': {
        const block = field.readUIntLE(0, 3), type = (block >>> 1) & 3, size = block >>> 3
        if (type === 3 || size > 128 * 1024) throw new Error('Invalid zstd block')
        last = (block & 1) !== 0
        next('payload', type === 1 ? 1 : size)
        break
      }
      case 'payload':
        if (!last) next('block', 3)
        else if (checksum) next('checksum', 4)
        else boundary()
        break
      case 'checksum': boundary(); break
      case 'skipSize': next('skip', field.readUInt32LE(0)); break
      case 'skip': boundary(); break
    }
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(need - used, chunk.length - offset)
          if (state !== 'payload' && state !== 'skip') chunk.copy(field, used, offset, offset + count)
          used += count; offset += count
          while (used === need) advance()
        }
        done(null, chunk)
      } catch (error) { done(error as Error) }
    },
    flush(done) {
      done(frames > 0 && state === 'magic' && used === 0 ? undefined : new Error('Incomplete zstd frame'))
    },
  })
}
