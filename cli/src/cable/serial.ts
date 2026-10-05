// The serial port under the cable protocol: finding the dial, opening it raw, reading and writing bytes.
//
// No native dependency, deliberately. This CLI ships as one bundled JavaScript file with seven pure-JS
// dependencies; a serial library would be its first native module and would drag node-gyp, prebuilds and
// a per-platform release matrix into a distribution that is currently a download. A tty is a file, `stty`
// puts it in raw mode, and that is the whole of what this needs.
import { execFile } from 'node:child_process'
import { closeSync, constants, existsSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

// Darwin's O_EXLOCK (sys/fcntl.h). Node accepts it as an open flag but does not
// expose the constant. The kernel arbitrates competing opens across users;
// lsof cannot see another macOS account's descriptors and also has a TOCTOU race.
const DARWIN_O_EXLOCK = 0x20

/** The SoC's own USB peripheral. The dial exposes this and nothing else — measured, see findDialPort. */
export const DIAL_VENDOR_ID = 0x303a
export const DIAL_PRODUCT_ID = 0x1001

export interface DialPort {
  path: string
  vendorId: number
  productId: number
  serialNumber?: string
  /**
   * Which ATTACHMENT of that device this is: macOS's per-enumeration `sessionID`, Linux's bus:devnum.
   * It changes when the device is unplugged and plugged back in, and stays put while it sits there,
   * INCLUDING across a reset or a reflash over USB-Serial/JTAG (measured: esptool's hard reset leaves
   * the sessionID as it was). So it lets a verdict about a board ("not a dial") outlast a daemon restart
   * and end at an unplug, but it cannot say the board was reflashed; the fleet watches for that.
   */
  session?: string
}

/**
 * Find the dial's tty, matching on the USB id and nothing else.
 *
 * Never by name and never by "the only one there": names are localised and unstable, and a laptop has
 * other serial devices — this machine answers with `/dev/cu.debug-console` before anything else, which a
 * loose match happily returns.
 *
 * On macOS the ids and the device path live on DIFFERENT nodes of the `ioreg` tree: the USB device node
 * carries idVendor/idProduct, and IOCalloutDevice hangs several levels below it under the CDC driver. So
 * this arms a subtree at the matching node's indentation and takes the first path inside it. A flat scan
 * pairs a vendor id with whatever path happens to come next in the dump, which is a different device.
 */
export async function findDialPort(): Promise<DialPort | null> {
  return (await findDialPorts())[0] ?? null
}

/** Every matching USB device; each gets its own protocol session. */
export async function findDialPorts(): Promise<DialPort[]> {
  if (process.platform === 'darwin') return findDarwin()
  if (process.platform === 'linux') return findLinux()
  return []
}

/**
 * Is another process holding this tty open right now?
 *
 * The daemon looks at every USB Espressif board on the desk, and most of them are not dials: they are
 * somebody's work in progress, with esptool, `idf.py monitor` or a serial console on the other end. Two
 * readers on one tty interleave bytes, and that corrupts a flash or a log, so a port somebody else has
 * open is left alone and looked at again later. Cannot tell (no `lsof`, a timeout) reads as free: a
 * daemon that never opens anything because a tool is missing would be worse than one that sometimes does.
 */
export async function portInUse(path: string): Promise<boolean> {
  const pids = (out: unknown) => String(out ?? '').split('\n').map(l => Number(l.trim())).filter(n => n > 0 && n !== process.pid)
  try {
    const { stdout } = await runFile('lsof', ['-t', '--', path], { timeout: 5000 })
    return pids(stdout).length > 0
  } catch (error) {
    // lsof exits 1 when nothing has the file open, but also when it lists holders and warns about
    // something else (a stale network mount is enough), so what it printed counts either way.
    return pids((error as { stdout?: unknown }).stdout).length > 0
  }
}

/** Indentation column of an ioreg line — the tree's only structure. */
function depthOf(line: string): number {
  const m = line.match(/^[\s|+-]*/)
  return m ? m[0].length : 0
}

async function findDarwin(): Promise<DialPort[]> {
  let dump: string
  try {
    // Keep each USB device's children (the tty lives below its vendor/product IDs), but do not
    // serialize the whole IOService plane every two seconds just to detect a hot-plugged dial.
    const { stdout } = await runFile('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-w0', '-l'], { maxBuffer: 64 * 1024 * 1024 })
    dump = stdout
  } catch {
    throw new Error('Could not enumerate USB dials')
  }
  return parseDarwinDialPorts(dump)
}

export function parseDarwinDialPorts(dump: string): DialPort[] {
  const lines = dump.split('\n')
  const ports: DialPort[] = []
  const seen = new Set<string>()
  let armedAt: number | null = null
  let armedSerial: string | undefined
  let armedSession: string | undefined
  let serialNumber: string | undefined
  let sawVendor = false
  let sawProduct = false
  let nodeDepth = 0

  for (const line of lines) {
    // A new node resets what we have seen about the current one. `+-o` opens a node in this dump.
    if (line.includes('+-o')) {
      const d = depthOf(line)
      if (armedAt !== null && d <= armedAt) { armedAt = null; armedSerial = undefined; armedSession = undefined }
      nodeDepth = d
      sawVendor = false
      sawProduct = false
      serialNumber = undefined
      continue
    }

    if (line.includes('"idVendor"')) sawVendor = Number(line.split('=')[1]?.trim()) === DIAL_VENDOR_ID
    if (line.includes('"idProduct"')) sawProduct = Number(line.split('=')[1]?.trim()) === DIAL_PRODUCT_ID
    if (line.includes('"USB Serial Number"')) {
      serialNumber = line.split('=')[1]?.trim().replace(/^"|"$/g, '')
      if (armedAt === nodeDepth) armedSerial = serialNumber
    }
    // The USB device node's own sessionID (the interfaces below it carry ones of their own).
    if (line.includes('"sessionID"') && armedAt === nodeDepth) armedSession = line.split('=')[1]?.trim()
    if (sawVendor && sawProduct && armedAt === null) { armedAt = nodeDepth; armedSerial = serialNumber }

    if (armedAt !== null && line.includes('"IOCalloutDevice"')) {
      const path = line.split('=')[1]?.trim().replace(/^"|"$/g, '')
      if (path && !seen.has(path)) {
        ports.push({
          path, vendorId: DIAL_VENDOR_ID, productId: DIAL_PRODUCT_ID,
          ...(armedSerial ? { serialNumber: armedSerial } : {}),
          ...(armedSession ? { session: armedSession } : {}),
        })
        seen.add(path)
      }
    }
  }
  return ports
}

function findLinux(): DialPort[] {
  // /sys is the id, /dev/ttyACM* is the path, and the symlink between them is the only honest pairing.
  const base = '/sys/class/tty'
  if (!existsSync(base)) return []
  const ports: DialPort[] = []
  for (const name of readdirSync(base)) {
    if (!name.startsWith('ttyACM') && !name.startsWith('ttyUSB')) continue
    // The ids live on the USB device, a few directories up from the tty's own node.
    let dir = `${base}/${name}/device`
    for (let hop = 0; hop < 4; hop++) {
      try {
        const vid = parseInt(readFileSync(`${dir}/idVendor`, 'utf8').trim(), 16)
        const pid = parseInt(readFileSync(`${dir}/idProduct`, 'utf8').trim(), 16)
        if (vid === DIAL_VENDOR_ID && pid === DIAL_PRODUCT_ID) {
          let serialNumber: string | undefined
          try { serialNumber = readFileSync(`${dir}/serial`, 'utf8').trim() } catch { /* older USB descriptors */ }
          let session: string | undefined
          try {
            session = `${readFileSync(`${dir}/busnum`, 'utf8').trim()}:${readFileSync(`${dir}/devnum`, 'utf8').trim()}`
          } catch { /* no attachment identity: verdicts on this port are short-lived */ }
          ports.push({
            path: `/dev/${name}`, vendorId: vid, productId: pid,
            ...(serialNumber ? { serialNumber } : {}), ...(session ? { session } : {}),
          })
        }
        break
      } catch {
        dir = `${dir}/..`
      }
    }
  }
  return ports
}

/**
 * An open port, in raw mode, driven by the kernel's readiness notifications.
 *
 * The port coming and going — a flash, a crash, a nudged cable, the dial rebooting into a new image — is
 * the NORMAL case here, not the failure case. Everything about this class is written so that closing and
 * reopening is cheap and safe.
 */
export class SerialLink {
  private constructor(
    readonly path: string,
    private readonly stream: ReadStream,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onClosed: (why: string) => void,
    private readonly claimFd?: number,
  ) {
    stream.on('data', (chunk: Buffer) => {
      if (this.closed) return
      try { this.onData(chunk) }
      catch (error) { void this.close((error as NodeJS.ErrnoException).code ?? String(error)) }
    })
    stream.on('error', (error: NodeJS.ErrnoException) => { void this.close(error.code ?? String(error)) })
    stream.once('end', () => { void this.close('end of stream') })
    stream.once('close', () => {
      this.streamClosed = true
      void this.close('end of stream')
    })
  }

  private closed = false
  private closePromise: Promise<void> | null = null
  private streamClosed = false

  static async open(
    path: string,
    onData: (chunk: Buffer) => void,
    onClosed: (why: string) => void,
  ): Promise<SerialLink> {
    // Keep the claim on a separate open description: libuv reopens/replaces
    // the stream's descriptor and would otherwise release this advisory lock.
    // Acquire it before stty can change a port another Harness is using.
    const claimFd = process.platform === 'darwin'
      ? openSync(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK | DARWIN_O_EXLOCK)
      : undefined
    let retainedClaim = false
    try {
      // Raw mode is not optional. Left in the default line discipline the tty maps CR to NL, strips the
      // eighth bit on some paths and echoes what we write back at us — and a mangled frame is
      // indistinguishable from a bad cable at the far end.
      //
      // `clocal` belongs with it: it tells the line discipline to ignore modem control lines, so losing
      // carrier — which is what unplugging a USB serial device looks like — does not hang the port up
      // underneath us.
      const flag = process.platform === 'darwin' ? '-f' : '-F'
      await runFile('stty', [flag, path, 'raw', 'clocal', '-echo', '-echoe', '-echok', '-echoctl', '-echoke', 'min', '1', 'time', '0'])

      // O_NOCTTY IS LOAD-BEARING, AND ITS ABSENCE KILLED THE DAEMON.
      //
      // The daemon is spawned detached, which makes it a session leader. A session leader that opens a tty
      // without this flag ACQUIRES it as its controlling terminal — and when the USB device is unplugged the
      // kernel sends SIGHUP to that terminal's process group. Default disposition for SIGHUP is terminate,
      // so pulling the cable killed the process outright: no exception, no stack, nothing for the
      // unhandledRejection guard to catch, and a log that simply stops mid-second.
      //
      // Measured 2026-08-24: the daemon died at the exact second the cable came out, every time, and the
      // dial then greeted an empty room until it timed out and showed no agents.
      // FileHandle.read either occupies a worker while idle or needs EAGAIN polling. A TTY stream
      // uses libuv readiness instead, including short writes/backpressure, without a polling timer.
      // ReadStream is a net.Socket; opening O_RDWR and enabling both sides makes it full duplex.
      const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
      let stream: ReadStream
      try { stream = new ReadStream(fd, { readable: true, writable: true }) }
      catch (error) { closeSync(fd); throw error }
      // On POSIX libuv normally reopens the tty and owns a duplicate. On its fallback path it owns
      // the supplied fd itself. Check the native handle exactly once so neither path leaks a
      // descriptor or closes it twice. The managed Node runtime's real-PTY tests cover ownership.
      const streamFd = (stream as ReadStream & { _handle: { fd: number } })._handle.fd
      if (streamFd !== fd) {
        try { closeSync(fd) }
        catch (error) { stream.destroy(); throw error }
      }
      const link = new SerialLink(path, stream, onData, onClosed, claimFd)
      retainedClaim = true
      return link
    } finally {
      if (!retainedClaim && claimFd !== undefined) closeSync(claimFd)
    }
  }

  /**
   * Write every byte of ONE frame. libuv handles short writes without polling for capacity.
   *
   * ⚠️ SERIALISED, AND NOT AS A PRECAUTION. A tty accepts a few hundred bytes at a time, so an 8 KB
   * firmware slice takes several native writes before its callback completes. Frames
   * come from several places at once — the 5-second ping, the per-tick agent sync, a slice pump — and
   * without this queue a JSON frame lands in the MIDDLE of a firmware slice. The dial's decoder resyncs
   * past the wreckage, which costs it both frames, and the transfer then fails at the far end with a
   * checksum error that says nothing about whose fault it was.
   *
   * The firmware holds exactly this invariant on its own side (`s_tx_lock` in cable_link.c, "two tasks
   * sending at once cannot interleave halves of two frames"). This is the mirror of it. A failed write
   * must not strand the writes queued behind it, so the tail deliberately swallows the rejection — the
   * caller still receives it.
   */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed')
    const next = this.tail.then(() => this.writeFrame(bytes))
    this.tail = next.catch(() => {})
    return next
  }

  private tail: Promise<void> = Promise.resolve()

  private async writeFrame(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed')
    await new Promise<void>((resolve, reject) => {
      this.stream.write(bytes, (error) => {
        if (error) reject(error)
        // Node 20 can invoke a cancelled native write's callback without an error
        // after destroying its stream. Do not acknowledge that interrupted frame.
        else if (this.closed || this.stream.destroyed) reject(new Error('port closed'))
        else resolve()
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  close(why = 'closed'): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    let finish!: () => void
    this.closePromise = new Promise<void>((resolve) => { finish = resolve }).then(() => {
      try { if (this.claimFd !== undefined) closeSync(this.claimFd) }
      finally { this.onClosed(why) }
    })
    if (this.streamClosed) finish()
    else {
      this.stream.once('close', finish)
      this.stream.destroy()
    }
    return this.closePromise
  }
}
