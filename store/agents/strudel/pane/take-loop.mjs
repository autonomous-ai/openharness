import { wave } from './recording.mjs'

// A moment runs to the next distinct marker, or the end of the captured performance.
// Work in frames so playback uses the original samples, independent of UI timers.
export function markedPassage(take, marker) {
  const { sampleRate, frames } = take.audio
  const markers = take.events.filter((event) => event.type === 'marker')
  if (!markers.includes(marker) || !Number.isFinite(marker.at) || !sampleRate || !frames) return null
  const startFrame = Math.max(0, Math.min(frames, Math.round(marker.at * sampleRate)))
  const next = markers.filter((event) => event.at > marker.at).reduce((end, event) => Math.min(end, event.at), frames / sampleRate)
  const endFrame = Math.max(startFrame, Math.min(frames, Math.round(next * sampleRate)))
  if (endFrame === startFrame) return null
  return { startFrame, endFrame, start: startFrame / sampleRate, end: endFrame / sampleRate }
}

export function passageWave(bytes, audio, range) {
  const view = new DataView(bytes)
  if (bytes.byteLength !== 56 + audio.frames * 8 || view.getUint16(20, true) !== 3 ||
      view.getUint16(22, true) !== 2 || view.getUint32(24, true) !== audio.sampleRate ||
      view.getUint16(34, true) !== 32 || view.getUint32(52, true) !== audio.frames * 8)
    throw new Error('This recording cannot be looped: its audio does not match the saved take.')
  const { startFrame, endFrame } = range
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 ||
      endFrame > audio.frames || endFrame <= startFrame)
    throw new Error('Choose a moment with recorded audio after it.')
  return wave([bytes.slice(56 + startFrame * 8, 56 + endFrame * 8)], endFrame - startFrame, audio.sampleRate)
}
