// The recording branch emits silence. The engine's existing speaker connection stays untouched.
export class CaptureFrames {
  constructor(maxFrames, send) {
    this.maxFrames = maxFrames
    this.send = send
    this.frames = 0
    this.offset = 0
    this.buffer = new Float32Array(8192)
    this.started = false
    this.done = false
  }
  flush() {
    if (!this.offset) return
    const data = this.buffer.slice(0, this.offset * 2)
    this.send({ type: 'chunk', data }, [data.buffer])
    this.offset = 0
  }
  stop(reason = 'finished') {
    if (this.done) return
    this.done = true
    this.flush()
    this.send({ type: 'done', frames: this.frames, reason })
  }
  push(channels, length, frame) {
    if (this.done) return false
    if (!this.started) {
      this.started = true
      this.send({ type: 'start', frame })
    }
    const count = Math.min(length, this.maxFrames - this.frames)
    for (let i = 0; i < count; i++) {
      this.buffer[this.offset * 2] = channels[0]?.[i] || 0
      this.buffer[this.offset * 2 + 1] = (channels[1] || channels[0])?.[i] || 0
      this.offset++
      this.frames++
      if (this.offset === 4096) this.flush()
    }
    if (this.frames >= this.maxFrames) this.stop('limit')
    return !this.done
  }
}

// Guard makes the exact capture buffer independently testable in Node.
if (typeof registerProcessor === 'function') {
  registerProcessor(
    'strudel-take',
    class extends AudioWorkletProcessor {
      constructor(options) {
        super()
        const limit = Math.min(6_000_000, Math.max(1, Math.floor(options.processorOptions.maxFrames)))
        this.capture = new CaptureFrames(limit, (message, transfer = []) =>
          this.port.postMessage(message, transfer)
        )
        this.armed = false
        this.port.onmessage = ({ data }) => {
          if (data.type === 'start') this.armed = true
          if (data.type === 'stop') this.capture.stop(data.reason)
        }
      }
      process(inputs, outputs) {
        const length = outputs[0]?.[0]?.length || 128
        // Output arrays are zero-initialized by Web Audio: no duplicate monitor audio.
        if (!this.armed) return true
        return this.capture.push(inputs[0] || [], length, currentFrame)
      }
    }
  )
}
