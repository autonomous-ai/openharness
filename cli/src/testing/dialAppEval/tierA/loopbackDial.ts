/**
 * The round dial for tier A, on a loopback port both ends of which are in this process, as cableSession.spec.ts's
 * LoopbackPort is: the devices' real CableFleet finds it through its `discover` and opens it through its `open`, and it
 * speaks the cable protocol with the daemon's own frame codec, greeting as the firmware does with `appFilter: 'v1'`.
 * It keeps what the glass would show with the firmware's carousel model (testing/dialCarousel.ts), and records every
 * frame it hears and every face it shows at the virtual time it happened.
 */
import type { CableFleetOptions } from '../../../cable/cableFleet.js'
import { CableDecoder, CableType, encodeCableFrame } from '../../../cable/cableFrame.js'
import type { CablePort } from '../../../cable/cableSession.js'
import { CAROUSEL_REFRESH_MS, DialCarousel, type DialMessage } from '../../dialCarousel.js'
import type { Seen } from '../types.js'

const PORT_PATH = '/dev/eval-dial'
/** The firmware greets every 2 s until it is welcomed. */
const GREET_EVERY_MS = 2_000
const VOICE_RATE = 16_000
/**
 * As the round dial's firmware greets, with no `fw`: a greeting that names one has the daemon read the firmware manifest
 * over the network for an update to offer (cableHost.ts firmwareFor), and tier A reaches no network.
 */
const HELLO: DialMessage = { t: 'hello', product: 'harness', proto: 3, mac: 'e2:e0:00:00:0e:a1', hw: 'eval', appFilter: 'v1' }

/** The dial's end of an open port. */
interface Link { onData(chunk: Buffer): void; onClosed(why: string): void; open: boolean }

export class LoopbackDial {
  readonly frames: Seen['frames'] = []
  readonly faces: Seen['faces'] = []
  readonly cable: Partial<CableFleetOptions>
  /** Welcomed since the port last opened. */
  welcomed = false
  /** The app whose ring the daemon last said it shows (`apps`'s `shown`): the face's page. */
  private page = ''
  private plugged = false
  private link: Link | undefined
  private readonly carousel = new DialCarousel()
  private uploads = 0

  /** `now`: the virtual time each frame and face is recorded at. */
  constructor(private readonly now: () => number) {
    this.cable = {
      discover: async () => (this.plugged ? [{ path: PORT_PATH, vendorId: 0x303a, productId: 0x1001, serialNumber: 'EVAL-DIAL' }] : []),
      open: async (_path, onData, onClosed) => {
        // As a serial port that is gone fails to open.
        if (!this.plugged) throw new Error('the dial is not plugged in')
        return this.opened(onData, onClosed)
      },
      inUse: async () => false,
      canUseUsb: () => true,
      reset: async () => false,
    }
    // The firmware's refresh task, which applies a list a moment after it ends.
    setInterval(() => {
      this.carousel.refresh()
      this.face()
    }, CAROUSEL_REFRESH_MS)
  }

  send(message: DialMessage): void {
    if (this.link?.open) this.link.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8'))))
  }

  /** A tap on the agent's tile. */
  tap(agentId: string): void {
    this.send({ t: 'agent.open', agentId })
  }

  /** A turn of the dial to the agent's tile: the face moves there at once, and the daemon is told. */
  swipe(agentId: string): void {
    this.carousel.heard({ t: 'focus', agentId })
    this.face()
    this.send({ t: 'focus', agentId })
  }

  /** What the microphone heard, spoken to the agent on the face. */
  voice(pcm: Buffer[]): void {
    const uploadId = `eval-voice-${++this.uploads}`
    const agentId = this.carousel.tiles[this.carousel.active]
    this.send({ t: 'voice.begin', ...(agentId ? { agentId } : {}), uploadId, sr: VOICE_RATE, lang: 'en' })
    for (const chunk of pcm) if (this.link?.open) this.link.onData(Buffer.from(encodeCableFrame(CableType.Pcm, chunk)))
    this.send({ t: 'voice.end', uploadId })
  }

  /** A tap on an app in APPS (ui_habitat.c `app_pick`). */
  pick(app: string): void {
    this.send({ t: 'app.pick', app })
    this.carousel.picked(app)
  }

  /** The cable pulled: the port closes under the daemon, and discovery finds no dial. */
  unplug(): void {
    this.plugged = false
    const link = this.link
    if (!link?.open) return
    link.open = false
    this.welcomed = false
    link.onClosed('the dial was unplugged')
  }

  /** Plugged in: the fleet's next scan finds it and opens its port. */
  replug(): void {
    this.plugged = true
  }

  private opened(onData: Link['onData'], onClosed: Link['onClosed']): CablePort {
    const link: Link = { onData, onClosed, open: true }
    this.link = link
    this.welcomed = false
    const decoder = new CableDecoder()
    // On a timer, as the firmware's greeting comes after the port opened, never inside the open.
    setTimeout(() => this.greet(link), 0)
    const dial = this
    return {
      path: PORT_PATH,
      get isOpen() { return link.open },
      async write(bytes) {
        decoder.feed(Buffer.from(bytes), (frame) => {
          if (frame.type === CableType.Json) dial.heard(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as DialMessage)
        })
      },
      async close(why = 'closed') {
        if (!link.open) return
        link.open = false
        // A serial link says its own close.
        link.onClosed(why)
      },
    }
  }

  private greet(link: Link): void {
    if (!link.open || this.link !== link || this.welcomed) return
    this.send(HELLO)
    setTimeout(() => this.greet(link), GREET_EVERY_MS)
  }

  private heard(message: DialMessage): void {
    this.frames.push({ at: this.now(), message })
    if (message.t === 'welcome') this.welcomed = true
    if (message.t === 'apps') this.page = typeof message.shown === 'string' ? message.shown : ''
    this.carousel.heard(message)
    this.face()
    // A dial that stops answering for 20 s is taken as unplugged (cableSession.ts SILENCE_MS). After the write that
    // carried the ping, as the firmware's answer comes back over the wire.
    if (message.t === 'ping') queueMicrotask(() => this.send({ t: 'pong' }))
  }

  /** The face, recorded when it changed. */
  private face(): void {
    const { tiles, active } = this.carousel
    const shown = { page: this.page, tiles: [...tiles], active: tiles[active] ?? null }
    const last = this.faces.at(-1)
    if (last && last.page === shown.page && last.active === shown.active && last.tiles.join('\n') === shown.tiles.join('\n')) return
    this.faces.push({ at: this.now(), ...shown })
  }
}
