// Lossless stereo float WAV: preserve the engine's samples, without normalizing or clipping them.
export function wave(chunks, frames, sampleRate) {
  const header = new ArrayBuffer(56),
    view = new DataView(header)
  const tag = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 48 + frames * 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 8, true)
  view.setUint16(32, 8, true)
  view.setUint16(34, 32, true)
  tag(36, 'fact')
  view.setUint32(40, 4, true)
  view.setUint32(44, frames, true)
  tag(48, 'data')
  view.setUint32(52, frames * 8, true)
  return new Blob([header, ...chunks], { type: 'audio/wav' })
}

const modules = new WeakMap()
export async function capture(context, source, onProgress = () => {}) {
  if (!context.audioWorklet)
    throw new Error('Recording needs a browser with AudioWorklet support on localhost.')
  let loading = modules.get(context)
  if (!loading) {
    loading = context.audioWorklet.addModule('/_pane/capture-worklet.mjs').catch((error) => {
      modules.delete(context)
      throw error
    })
    modules.set(context, loading)
  }
  await loading
  await context.resume()
  const maxFrames = Math.min(6_000_000, context.sampleRate * 120)
  const node = new AudioWorkletNode(context, 'strudel-take', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { maxFrames }
  })
  const silent = context.createGain()
  silent.gain.value = 0
  const chunks = []
  let count = 0,
    startedAt = null,
    completed = false,
    stopTimer,
    startTimer
  let finish, fail, begin, failBegin
  const done = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  // A rejected completion is also awaited by the UI after start; avoid an unhandled race.
  done.catch(() => {})
  const started = new Promise((resolve, reject) => {
    begin = resolve
    failBegin = reject
  })
  started.catch(() => {})
  function clean() {
    completed = true
    clearTimeout(stopTimer)
    clearTimeout(startTimer)
    try {
      source.disconnect(node)
    } catch {}
    node.disconnect()
    silent.disconnect()
    node.port.close()
    context.removeEventListener('statechange', stateChange)
  }
  function abort(error) {
    if (completed) return
    clean()
    failBegin(error)
    fail(error)
  }
  function stateChange() {
    // A suspended context cannot answer a stop request. Keep every chunk already delivered.
    if (context.state !== 'running') end('audio suspended')
  }
  function end(reason, exactFrames = count) {
    if (completed) return
    if (exactFrames !== count) return abort(new Error('The recording lost an audio chunk. Please try again.'))
    clean()
    if (!startedAt && startedAt !== 0) {
      failBegin(new Error('Audio did not start.'))
      fail(new Error('Audio did not start.'))
      return
    }
    finish({
      blob: wave(chunks, count, context.sampleRate),
      frames: count,
      sampleRate: context.sampleRate,
      startedAt,
      duration: count / context.sampleRate,
      reason
    })
  }
  node.onprocessorerror = () => abort(new Error('The audio recorder stopped unexpectedly.'))
  node.port.onmessage = ({ data }) => {
    if (completed) return
    if (data.type === 'start') {
      clearTimeout(startTimer)
      startedAt = data.frame / context.sampleRate
      begin(startedAt)
    }
    if (data.type === 'chunk') {
      chunks.push(data.data)
      count += data.data.length / 2
      onProgress(count / context.sampleRate)
    }
    if (data.type === 'done') end(data.reason, data.frames)
  }
  context.addEventListener('statechange', stateChange)
  node.connect(silent)
  silent.connect(context.destination)
  source.connect(node)
  return {
    started,
    done,
    maxSeconds: maxFrames / context.sampleRate,
    start() {
      node.port.postMessage({ type: 'start' })
      startTimer = setTimeout(() => abort(new Error('The audio recorder did not start.')), 5000)
    },
    stop(reason = 'finished') {
      if (completed || stopTimer) return done
      node.port.postMessage({ type: 'stop', reason })
      stopTimer = setTimeout(() => end('audio interrupted'), 2000)
      return done
    }
  }
}

export function packTake(manifest, wav) {
  const json = new TextEncoder().encode(JSON.stringify(manifest)),
    length = new ArrayBuffer(4)
  new DataView(length).setUint32(0, json.length, true)
  return new Blob([length, json, wav], { type: 'application/octet-stream' })
}
