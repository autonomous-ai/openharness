// The two things about a firmware push that fail silently and at the far end.
//
//  · WHICH image gets offered. Offering the wrong one is not a crash: the dial takes it, reboots, and runs
//    software nobody chose — the sibling product lost a fresh build to an older bundle twice before anyone
//    noticed, because `idf.py flash` said Done and the panel looked fine.
//  · HOW FAST it goes out. The ESP32-S3 USB peripheral has no back-pressure, so sending past the credit
//    window does not slow this side down — the dial's ring overflows and the bytes are gone with no error.
import { describe, expect, it, vi } from 'vitest'

import { CIRCLE_OTA_KEY, FW_SLICE_BYTES, FW_WINDOW_BYTES, FirmwareTransfer, PRO_OTA_KEY, otaKeyForBoard, shouldOffer } from './fwPush.js'

describe('shouldOffer', () => {
  it('offers a strictly newer release', () => {
    expect(shouldOffer('0.0.35', '0.0.36')).toBe(true)
    expect(shouldOffer('0.0.35', '0.1.0')).toBe(true)
    expect(shouldOffer('v0.0.35', '0.1.0')).toBe(true)
  })

  it('does nothing for the same version', () => {
    expect(shouldOffer('0.0.35', '0.0.35')).toBe(false)
  })

  it('never rolls a dial backwards', () => {
    // A rollback is a decision made by publishing, not by whichever daemon happens to be plugged in.
    expect(shouldOffer('0.1.0', '0.0.36')).toBe(false)
  })

  it('never touches a dev build', () => {
    // ESP-IDF stamps `git describe` when the project sets no PROJECT_VER. Offering the published image to
    // one of these is exactly how a just-flashed build gets silently replaced seconds later.
    expect(shouldOffer('v0.3.38-36-gbc64073-dirty', '9.9.9')).toBe(false)
    expect(shouldOffer('0.0.35-dirty', '0.0.36')).toBe(false)
    expect(shouldOffer('', '0.0.36')).toBe(false)
  })
})

describe('FirmwareTransfer', () => {
  /** A transfer whose slices are collected instead of written to a port. */
  function make(size: number) {
    const sent: number[] = []
    const image = Buffer.alloc(size, 7)
    const t = new FirmwareTransfer(image, '1.2.3', async (slice) => { sent.push(slice.length) }, () => {})
    return { t, sent, image }
  }

  it('stops at the credit window and goes no further until acked', async () => {
    const { t, sent } = make(1_000_000)
    await t.pump()
    const inFlight = sent.reduce((a, b) => a + b, 0)
    expect(inFlight).toBeLessThanOrEqual(FW_WINDOW_BYTES + FW_SLICE_BYTES)

    // Nothing more moves without an ack — that is the whole mechanism. Calling pump() again must not
    // sneak another slice out.
    const before = sent.length
    await t.pump()
    expect(sent.length).toBe(before)
  })

  it('each ack releases exactly as much as it retired', async () => {
    const { t, sent } = make(1_000_000)
    await t.pump()
    const first = sent.length
    await t.onProgress(FW_SLICE_BYTES) // the dial wrote one slice
    expect(sent.length).toBe(first + 1)
  })

  it('delivers the whole image, in order, in slices no larger than the agreed one', async () => {
    const size = FW_SLICE_BYTES * 5 + 123
    const { t, sent } = make(size)
    await t.pump()
    let acked = 0
    while (acked < size) {
      acked = Math.min(acked + FW_SLICE_BYTES, size)
      await t.onProgress(acked)
    }
    expect(sent.reduce((a, b) => a + b, 0)).toBe(size)
    expect(Math.max(...sent)).toBeLessThanOrEqual(FW_SLICE_BYTES)
    expect(sent.at(-1)).toBe(123) // the tail is short, not padded
  })

  it('sends every slice exactly once when acks land mid-write', async () => {
    // THE FIELD FAILURE, REPRODUCED. On 2026-08-24 a 3,091,648-byte push reached the dial with slice 130
    // written twice — once where it belonged and once over slice 131, which never arrived at all. Both
    // writes were a full 8192 bytes, so the dial's counter read 3091648/3091648 and the daemon logged a
    // complete transfer; only esp_ota_end caught it, as a checksum error that pointed nowhere near here.
    //
    // The cause was ordinary: pump() advanced `offset` AFTER awaiting the write, and `fw.progress` — which
    // the read loop dispatches while that write is parked — called pump() again, which read the same
    // unadvanced offset and sent the same slice.
    //
    // Every other test in this file passes a sendSlice that returns immediately, which is why none of them
    // saw it: with no await gap there is no window for the ack to arrive in. This one parks, acks from
    // inside the write, and asserts on the reassembled BYTES rather than their count — the count was the
    // one thing that stayed correct.
    const slices = 40
    const size = FW_SLICE_BYTES * slices
    const image = Buffer.alloc(size)
    for (let i = 0; i < size; i++) image[i] = Math.floor(i / FW_SLICE_BYTES) & 0xff // each slice, its own byte

    const sent: Buffer[] = []
    let acked = 0
    let transfer: FirmwareTransfer
    transfer = new FirmwareTransfer(
      image,
      '1.2.3',
      async (slice) => {
        sent.push(Buffer.from(slice)) // a copy: the argument is a view into the image
        await Promise.resolve() // a real write parks here, several times, on a tty
        if (acked < size) {
          acked += FW_SLICE_BYTES
          void transfer.onProgress(acked) // the read loop does not wait for the writer, and neither does this
        }
      },
      () => {},
    )

    await transfer.pump()

    expect(sent.length).toBe(slices)
    expect(Buffer.concat(sent).equals(image)).toBe(true)
  })

  it('says how far it got when it is cut off', async () => {
    const log = vi.fn()
    const image = Buffer.alloc(100_000)
    const t = new FirmwareTransfer(image, '1.2.3', async () => {}, log)
    await t.pump()
    await t.onProgress(40_000)
    t.finish('interrupted by the port closing')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('40000/100000'))
    // Finishing twice must not double-log: the port closing and the session ending both call it.
    t.finish('again')
    expect(log).toHaveBeenCalledTimes(1)
  })
})

// ONE IMAGE PER BOARD, AND NEVER A GUESS.
//
// Until Harness Pro existed there was one kind of device on the cable, so the offer took the manifest's
// default entry. Two boards later that default is a brick: the Pro is an ESP32-P4 and the dial an
// ESP32-S3, neither can run the other's image, and the cable that would let anyone put it right is the
// firmware that just stopped booting. So the board decides the entry, and an unrecognised one is offered
// nothing at all.
describe('which firmware a board may be offered', () => {
  it('sends each board to its own manifest entry', () => {
    expect(otaKeyForBoard('cst9217+axp2101')).toBe(CIRCLE_OTA_KEY)
    expect(otaKeyForBoard('cst816s')).toBe(CIRCLE_OTA_KEY)
    expect(otaKeyForBoard('harness-pro')).toBe(PRO_OTA_KEY)
    expect(CIRCLE_OTA_KEY).not.toBe(PRO_OTA_KEY)
  })

  it('offers nothing to a board it does not recognise', () => {
    // A future board, or a device whose hello says something we have never seen. Refusing is the whole
    // point: the alternative is picking one of the two images we do have, and both are wrong.
    expect(otaKeyForBoard('harness-ultra')).toBeNull()
    expect(otaKeyForBoard('')).not.toBeNull()   // empty is "did not say", handled below — not unknown
  })

  it('treats a device that does not say as the dial', () => {
    // The one place a guess is right. `hw` has been in the hello since before the Pro was designed, so a
    // build that omits it predates the Pro and can only be a dial. Refusing those would stop updates
    // reaching exactly the devices most in need of one.
    expect(otaKeyForBoard(undefined)).toBe(CIRCLE_OTA_KEY)
    expect(otaKeyForBoard(null)).toBe(CIRCLE_OTA_KEY)
  })
})
