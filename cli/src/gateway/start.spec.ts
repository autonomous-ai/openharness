import { describe, expect, it, vi } from 'vitest'
import type { DevLogMember } from '../lib/e2ee/deviceLog.js'
import type { DeviceRemovalNotice } from '../lib/e2ee/deviceLogSyncer.js'
import { announceNewDevice, postDeviceAck, reportRemovedDevice } from './start.js'

describe('postDeviceAck', () => {
  // The backend's refusal is its own text: a code reads as itself, anything else by its length.
  it.each([
    ['a code', 'ACK_INVALID', '(500: ACK_INVALID)'],
    ['anything else', '/Users/sentinel', '(500: text(15))'],
  ])('a refusal whose code is %s is logged by it', async (_, code, shown) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const backend = vi.fn(async () => ({ status: 500, body: { error: { code } } }))
    try {
      expect(await postDeviceAck({ backend }, { sig: 'ack' })).toBe(false)

      expect(backend).toHaveBeenCalledWith('POST', '/api/device-keys/acks', { ack: { sig: 'ack' } }, 10_000)
      const lines = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(lines).not.toContain('sentinel')
      expect(lines).toBe(`[devlog] the backend did not keep "It's mine" ${shown}`)
    } finally {
      log.mockRestore()
    }
  })
})

describe('the device key log\'s news', () => {
  // Two keys of 32 bytes, all 7s and all 9s, and their fingerprints.
  const PUB = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
  const FP = '4BB0·6F8E·4E3A·7715'
  const SIGNER = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk='
  const SIGNER_FP = '8C0C·C17A·0494·2CC4'
  // A device's label is what a person named it, here a path naming their home: the windows show it, the log never.
  const LABEL = '/Users/sentinel/laptop'
  const member: DevLogMember = { pub: PUB, kind: 'machine', machineId: 'm-1', label: LABEL, addedAt: 5, seq: 3 }
  const notice = (over: Partial<DeviceRemovalNotice>): DeviceRemovalNotice => ({
    pub: PUB, label: LABEL, kind: 'viewer', fingerprint: FP, signer: SIGNER, signerLabel: '/Users/sentinel/phone',
    signerFingerprint: SIGNER_FP, signerPending: false, selfRemoved: false, at: 9, ...over,
  })
  const heard = (run: (events: { toWindows: (frame: Record<string, unknown>) => void }) => void) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const frames: Record<string, unknown>[] = []
    try {
      run({ toWindows: (frame) => frames.push(frame) })
      return { lines: log.mock.calls.map((call) => call.map(String).join(' ')), frames }
    } finally {
      log.mockRestore()
    }
  }

  it('says a new device by its kind and fingerprint, and hands the windows its label', () => {
    const { lines, frames } = heard((events) => announceNewDevice(events, member))
    expect(lines).toEqual([`[devlog] NEW DEVICE on this account: ${FP} (machine) — not yours? harness devices remove ${FP}`])
    expect(frames).toEqual([{ type: 'device_key_added', payload: { pub: PUB, label: LABEL, kind: 'machine', machineId: 'm-1', at: 5, fingerprint: FP } }])
  })

  it.each([
    ['signed out', { selfRemoved: true }, `[devlog] ${FP} (viewer) signed out of this account`],
    ['removed by a new device', { signerPending: true },
      `[devlog] ⚠ ${FP} (viewer) was removed by a NEW device you have not looked at: ${SIGNER_FP} — not yours? harness devices remove ${SIGNER_FP}`],
    ['removed by another device', {}, `[devlog] ${FP} (viewer) was removed from this account by ${SIGNER_FP}`],
  ])('says a device %s by the fingerprints, and hands the windows the labels', (_, over, line) => {
    const { lines, frames } = heard((events) => reportRemovedDevice(events, notice(over)))
    expect(lines).toEqual([line])
    expect(lines.join('\n')).not.toContain('sentinel')
    expect(frames).toEqual([{ type: 'device_key_removed', payload: notice(over) }])
  })
})
