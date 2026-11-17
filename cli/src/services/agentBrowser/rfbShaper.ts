/**
 * Enforces a route's stream profile on the bytes a browser viewer sends to Xvnc, on the agent's machine, so the
 * client never decides it (spec § "Stream profiles by route"). The first spike measured that the frame cap cuts
 * bytes far more than quality does, so update requests are paced and the quality and compression levels in
 * SetEncodings are the profile's.
 *
 * Client messages have no length prefix: each one's length comes from its type, so an unknown type closes the
 * stream rather than guessing. Lengths are from RFC 6143 § 7.5 and the community extensions in rfbproto
 * (github.com/rfbproto/rfbproto), checked against what noVNC 1.7.0's `RFB.messages` writes.
 */

export interface StreamProfile {
  quality: number
  compression: number
  fps: number
}

/**
 * Xvnc drops a clipboard message longer than its MaxCutText (256 KiB by default, and the entrypoint does not change
 * it), and every other client message is shorter (SetEncodings at most 4 + 4 * 65535), so nothing longer is worth
 * buffering.
 */
const MAX_MESSAGE = 8 + 256 * 1024

const QUALITY_0 = -32 // pseudo-encodings -32 to -23, RFC 6143 § 7.8 (JPEG quality level)
const COMPRESSION_0 = -256 // pseudo-encodings -256 to -247 (compression level)

/**
 * The encodings a client may not choose. The quality and compression levels are the profile's; TigerVNC's fine
 * quality (-512 to -412) and subsampling (-768 to -763) would override the quality level. Continuous updates (-313)
 * make Xvnc send frames without requests, which bypasses the frame cap; noVNC turns them on whenever Xvnc offers.
 * Extended mouse buttons (-316) make noVNC's PointerEvent 7 bytes instead of 6 once Xvnc confirms them, which only
 * the server's bytes would tell.
 */
function profileOwned(encoding: number): boolean {
  return (encoding >= QUALITY_0 && encoding <= QUALITY_0 + 9)
    || (encoding >= COMPRESSION_0 && encoding <= COMPRESSION_0 + 9)
    || (encoding >= -512 && encoding <= -412)
    || (encoding >= -768 && encoding <= -763)
    || encoding === -313
    || encoding === -316
}

/**
 * The whole length of the client message at the start of `b`, -1 when more bytes are needed to tell, or undefined
 * for a type this does not know.
 */
function messageLength(b: Uint8Array): number | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  switch (b[0]) {
    case 0: return 20 // SetPixelFormat, RFC 6143 § 7.5.1
    case 2: return b.length < 4 ? -1 : 4 + 4 * view.getUint16(2) // SetEncodings, § 7.5.2
    case 3: return 10 // FramebufferUpdateRequest, § 7.5.3
    case 4: return 8 // KeyEvent, § 7.5.4
    case 5: return 6 // PointerEvent, § 7.5.5 (the 7-byte extended form is never confirmed: see profileOwned)
    // ClientCutText, § 7.5.6; a negative length is rfbproto's extended clipboard, whose payload is -length bytes.
    case 6: return b.length < 8 ? -1 : 8 + Math.abs(view.getInt32(4))
    case 248: return b.length < 9 ? -1 : 9 + b[8] // rfbproto ClientFence: 8 header bytes, a length byte, payload
    case 250: return 4 // rfbproto xvp
    case 251: return b.length < 8 ? -1 : 8 + 16 * b[6] // rfbproto SetDesktopSize: 8 header bytes, 16 per screen
    // rfbproto QEMU client message: sub-type 0 is the 12-byte QEMU Extended Key Event, the only one noVNC sends.
    case 255: return b.length < 2 ? -1 : b[1] === 0 ? 12 : undefined
    // EnableContinuousUpdates (150) is left out on purpose: SetEncodings never offers it, and it bypasses the cap.
    default: return undefined
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  return joined
}

export class RfbShaper {
  private profile: StreamProfile
  private readonly now: () => number
  private readonly schedule: (ms: number, fn: () => void) => void
  private output: (bytes: Uint8Array) => void = () => {}
  private close: (reason: 'closed', detail: string) => void = () => {}
  private pending: Uint8Array = new Uint8Array(0)
  /** Client bytes of the handshake still to pass, once the version tells how many there are. */
  private handshake: number | undefined
  private closed = false
  private lastRequestAt: number | undefined
  private heldRequest: Uint8Array | undefined
  /** The encodings of the last SetEncodings the viewer sent, less those the profile owns. */
  private encodings: number[] | undefined

  constructor(
    profile: StreamProfile,
    now: () => number = () => performance.now(),
    schedule: (ms: number, fn: () => void) => void = (ms, fn) => { setTimeout(fn, ms) },
  ) {
    this.profile = profile
    this.now = now
    this.schedule = schedule
  }

  onOutput(fn: (bytes: Uint8Array) => void): void {
    this.output = fn
  }

  /** The stream must end: `detail` names the message, never its content, for the caller's log line. */
  onClose(fn: (reason: 'closed', detail: string) => void): void {
    this.close = fn
  }

  setProfile(profile: StreamProfile): void {
    this.profile = profile
    // The route is known only after the viewer's SetEncodings has passed, and noVNC sends it again only when its own
    // settings change, so the new levels go to Xvnc now. Between pushes the output sits at a message boundary.
    if (this.encodings) this.output(this.setEncodings(this.encodings))
  }

  push(bytes: Uint8Array): void {
    if (this.closed) return
    this.pending = concat(this.pending, bytes)
    let at = 0
    if (this.handshake === undefined) {
      if (this.pending.length < 12) return
      // ProtocolVersion (12 bytes), then with 3.7 and 3.8 the security type, then ClientInit. Xvnc offers only
      // security type None, which has no client bytes of its own; 3.3 has the server choose it, so no type byte.
      const minor = Number(new TextDecoder().decode(this.pending.subarray(8, 11)))
      this.handshake = minor >= 7 ? 14 : 13
    }
    if (this.handshake > 0) {
      const passing = Math.min(this.handshake, this.pending.length)
      this.handshake -= passing
      this.output(this.pending.subarray(0, passing))
      at = passing
    }
    while (at < this.pending.length) {
      const rest = this.pending.subarray(at)
      const length = messageLength(rest)
      if (length === undefined) {
        const type = rest[0] === 255 ? `255.${rest[1]}` : String(rest[0])
        return this.shut(`unknown RFB client message type ${type}`)
      }
      if (length > MAX_MESSAGE) return this.shut(`RFB client message type ${rest[0]} is ${length} bytes`)
      if (length < 0 || rest.length < length) break
      this.handle(rest.subarray(0, length))
      at += length
    }
    this.pending = this.pending.slice(at)
  }

  private handle(message: Uint8Array): void {
    if (message[0] === 2) {
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength)
      const encodings: number[] = []
      for (let i = 4; i < message.length; i += 4) {
        const encoding = view.getInt32(i)
        if (!profileOwned(encoding)) encodings.push(encoding)
      }
      this.encodings = encodings
      return this.output(this.setEncodings(encodings))
    }
    if (message[0] === 3) return this.request(message)
    this.output(message)
  }

  private setEncodings(encodings: number[]): Uint8Array {
    const all = [...encodings, QUALITY_0 + this.profile.quality, COMPRESSION_0 + this.profile.compression]
    const message = new Uint8Array(4 + 4 * all.length)
    const view = new DataView(message.buffer)
    message[0] = 2
    view.setUint16(2, all.length)
    all.forEach((encoding, i) => { view.setInt32(4 + 4 * i, encoding) })
    return message
  }

  /** Holds a FramebufferUpdateRequest until one frame interval has passed since the last one let through. */
  private request(message: Uint8Array): void {
    if (this.heldRequest) {
      // A held full refresh stays full: the newer incremental request would leave the viewer without it.
      const full = this.heldRequest[1] === 0
      this.heldRequest = message.slice()
      if (full) this.heldRequest[1] = 0
      return
    }
    const now = this.now()
    const interval = 1000 / this.profile.fps
    if (this.lastRequestAt === undefined || now - this.lastRequestAt >= interval) {
      this.lastRequestAt = now
      return this.output(message)
    }
    this.heldRequest = message.slice()
    this.schedule(this.lastRequestAt + interval - now, () => {
      const held = this.heldRequest
      this.heldRequest = undefined
      if (!held) return
      this.lastRequestAt = this.now()
      this.output(held)
    })
  }

  private shut(detail: string): void {
    this.closed = true
    this.heldRequest = undefined
    this.encodings = undefined
    this.pending = new Uint8Array(0)
    this.close('closed', detail)
  }
}
