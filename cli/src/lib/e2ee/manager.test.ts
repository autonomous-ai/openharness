import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The one module here imported statically rather than in beforeAll: a test timeout is needed when
// `it()` is DEFINED, long before beforeAll runs. Safe because passwordPake.js is pure crypto —
// noble plus core.js — and reaches config/env.js by no path, which is the only thing the deferral
// above exists to keep out until ADAPTER_DATA_DIR is set.
import { PW_SCRYPT_TEST_TIMEOUT_MS } from './passwordPake.js'

// The manager transitively imports config/env (validated at load) + writes the paired store to disk,
// so point ADAPTER_DATA_DIR at a temp dir BEFORE importing it (dynamic import in beforeAll).
type Frame = Record<string, unknown>
let C: typeof import('./core.js')
let makeManager: typeof import('./manager.js')['E2eeManager']
let pwCpaceGenerator: typeof import('./passwordPake.js')['pwCpaceGenerator']
let pwContext: typeof import('./passwordPake.js')['pwContext']
let stretchPassword: typeof import('./passwordPake.js')['stretchPassword']

const AGENT = 'f2e0383771b734e4fc00f0bc8ccf060f'

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-mgr-'))
  C = await import('./core.js')
  makeManager = (await import('./manager.js')).E2eeManager
  const pw = await import('./passwordPake.js')
  pwCpaceGenerator = pw.pwCpaceGenerator
  pwContext = pw.pwContext
  stretchPassword = pw.stretchPassword
})

// Fresh persisted store (identity + paired.json) per test — the store is disk-backed and shared by
// every manager instance, so without this pairs accumulate across tests.
beforeEach(() => {
  try { rmSync(join(process.env.ADAPTER_DATA_DIR as string, 'e2e'), { recursive: true, force: true }) } catch { /* none */ }
})

/** A minimal web peer that runs the CPace responder + session handshake against the manager. */
class WebPeer {
  constructor(readonly role: 'web' | 'device' = 'web') {}
  identity = C.newIdentity()
  session?: { c2s: Uint8Array; s2c: Uint8Array; groupKey: Uint8Array; epoch: string; myEph: import('./core.js').Ephemeral }
  adapterPub?: Uint8Array
  private pr?: { code: string; pairId: Uint8Array; pairIdB64: string; y?: bigint; Ya?: Uint8Array; Yb?: Uint8Array; isk?: Uint8Array; th?: Uint8Array }

  intent(pairId: Uint8Array): Frame {
    this.pr = { code: '', pairId, pairIdB64: C.b64e(pairId) }
    return { type: 'e2e_pair_intent', payload: { requestId: 'r1', pairId: this.pr.pairIdB64, label: 'Chrome · macOS', role: this.role } }
  }
  setCode(code: string): void { if (this.pr) this.pr.code = code }

  /** Handle an adapter→web pake frame; return the reply frame to feed back (or null). */
  onPake(frame: Frame): Frame | null {
    const p = frame.payload as Record<string, unknown>
    const pr = this.pr!
    const ci = C.pairContext(AGENT, this.role)
    const round = Number(p.round)
    if (round === 1) {
      const g = C.cpaceGenerator(pr.code, pr.pairId, ci)
      const { y, Y } = C.cpaceStart(g)
      const Ya = C.b64d(String(p.ya))
      const K = C.cpaceShared(Ya, y)
      pr.y = y; pr.Ya = Ya; pr.Yb = Y
      pr.isk = C.cpaceISK(pr.pairId, K, Ya, Y)
      pr.th = C.transcriptHash(pr.pairId, ci, Ya, Y)
      const kc = C.kcKeys(pr.isk, ci)
      return { type: 'e2e_pake', payload: { pairId: pr.pairIdB64, round: 2, yb: C.b64e(Y), mac: C.b64e(C.macTag(kc.web, pr.th)) } }
    }
    if (round === 3) {
      const kc = C.kcKeys(pr.isk!, ci)
      if (!C.macVerify(kc.adapter, pr.th!, C.b64d(String(p.mac)))) throw new Error('adapter MAC failed')
      const opened = C.aeadOpen(C.pairKey(pr.isk!, ci), 3, C.utf8('e2e-id'), C.b64d(String(p.enc)))!
      const adId = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
      if (!C.pairBindVerify(C.b64d(adId.id), pr.th!, C.b64d(adId.sig))) throw new Error('adapter bind sig failed')
      this.adapterPub = C.b64d(adId.id) // pin

      const sealed = C.aeadSeal(C.pairKey(pr.isk!, ci), 4, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(this.identity.pub), sig: C.b64e(C.pairBindSig(this.identity.priv, pr.th!)) })))
      return { type: 'e2e_pake', payload: { pairId: pr.pairIdB64, round: 4, enc: C.b64e(sealed) } }
    }
    return null // round 5 (ok/error) — nothing to send
  }

  hello(): Frame {
    const eph = C.newEphemeral()
    this.session = { c2s: new Uint8Array(), s2c: new Uint8Array(), groupKey: new Uint8Array(), epoch: '', myEph: eph }
    return { type: 'e2e_hello', payload: { identityPub: C.b64e(this.identity.pub), ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(this.identity.priv, AGENT, eph.pub)) } }
  }
  onWelcome(frame: Frame, adapterPub: Uint8Array): void {
    const p = frame.payload as Record<string, unknown>
    const adapterEphPub = C.b64d(String(p.ephPub))
    const myEphPub = this.session!.myEph.pub
    expect(C.welcomeVerify(adapterPub, AGENT, myEphPub, adapterEphPub, C.b64d(String(p.sig)))).toBe(true)
    const keys = C.sessionKeys(this.session!.myEph.priv, adapterEphPub, AGENT, myEphPub, adapterEphPub)
    const opened = C.aeadOpen(keys.s2c, 0, C.utf8('e2e-welcome'), C.b64d(String(p.enc)))!
    const { groupKey, epoch } = JSON.parse(new TextDecoder().decode(opened)) as { groupKey: string; epoch: string }
    this.session!.c2s = keys.c2s; this.session!.s2c = keys.s2c
    this.session!.groupKey = C.b64d(groupKey); this.session!.epoch = epoch
  }
  onRekey(frame: Frame): void {
    const p = frame.payload as Record<string, unknown>
    const opened = C.aeadOpen(this.session!.s2c, Number(p.n), C.utf8('e2e-rekey'), C.b64d(String(p.enc)))!
    const { groupKey, epoch } = JSON.parse(new TextDecoder().decode(opened)) as { groupKey: string; epoch: string }
    this.session!.groupKey = C.b64d(groupKey); this.session!.epoch = epoch
  }
}

/**
 * A joiner's stretched password, computed once per password for the whole file. `stretchPassword` is
 * deterministic for a password and machine, and each call is a real scrypt (~0.5-1 s and 128 MB idle;
 * the cost is a security control, never lowered for a test). Under a loaded full run (load 36, six
 * workers) "keeps at most two password attempts in flight" spent five of them, one per joiner, and
 * timed out. The manager's own stretch (`setRemotePassword`) is still real every time.
 */
const stretchedPasswords = new Map<string, Promise<Uint8Array>>()
function stretchedOnce(password: string): Promise<Uint8Array> {
  let stretched = stretchedPasswords.get(password)
  if (!stretched) stretchedPasswords.set(password, stretched = stretchPassword(password, AGENT))
  return stretched
}

/** A minimal remote-password joiner that runs the CPace 'b' role directly against the manager via
 *  handleFrame — mirrors WebPeer above, but for the persistent remote-password flow: no human "arm"
 *  step (intent() carries the stretched password straight away), and connId-keyed on the manager side
 *  instead of a single slot. */
class PwPeer {
  identity = C.newIdentity()
  peerPub?: Uint8Array
  /** What this joiner calls itself in its sealed identity; unset is a joiner that predates the field. */
  label?: string
  private pr?: { sid: Uint8Array; sidB64: string; stretched: Uint8Array; y?: bigint; Ya?: Uint8Array; isk?: Uint8Array; th?: Uint8Array }

  async intent(password: string): Promise<Frame> {
    const sid = C.newPairId()
    const stretched = await stretchedOnce(password)
    this.pr = { sid, sidB64: C.b64e(sid), stretched }
    return { type: 'e2e_pw_pair_intent', payload: { requestId: 'pwr1', sid: this.pr.sidB64 } }
  }

  /** Handle an adapter→joiner e2e_pw_pake frame; return the reply frame to feed back (or null on the
   *  terminal round 5 ok/error). */
  onPake(frame: Frame): Frame | null {
    const p = frame.payload as Record<string, unknown>
    const pr = this.pr!
    const ci = pwContext(AGENT)
    const round = Number(p.round)
    if (round === 1) {
      const g = pwCpaceGenerator(pr.stretched, pr.sid, ci)
      const { y, Y } = C.cpaceStart(g)
      const Ya = C.b64d(String(p.ya))
      const K = C.cpaceShared(Ya, y)
      pr.y = y; pr.Ya = Ya
      pr.isk = C.cpaceISK(pr.sid, K, Ya, Y)
      pr.th = C.transcriptHash(pr.sid, ci, Ya, Y)
      const kc = C.kcKeys(pr.isk, ci)
      return { type: 'e2e_pw_pake', payload: { sid: pr.sidB64, round: 2, yb: C.b64e(Y), mac: C.b64e(C.macTag(kc.web, pr.th)) } }
    }
    if (round === 3) {
      const kc = C.kcKeys(pr.isk!, ci)
      if (!C.macVerify(kc.adapter, pr.th!, C.b64d(String(p.mac)))) throw new Error('adapter MAC failed')
      const opened = C.aeadOpen(C.pairKey(pr.isk!, ci), 3, C.utf8('e2e-id'), C.b64d(String(p.enc)))!
      const adId = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
      if (!C.pairBindVerify(C.b64d(adId.id), pr.th!, C.b64d(adId.sig))) throw new Error('adapter bind sig failed')
      this.peerPub = C.b64d(adId.id) // pin

      const claim = { id: C.b64e(this.identity.pub), sig: C.b64e(C.pairBindSig(this.identity.priv, pr.th!)), ...(this.label !== undefined ? { label: this.label } : {}) }
      const sealed = C.aeadSeal(C.pairKey(pr.isk!, ci), 4, C.utf8('e2e-id'), C.utf8(JSON.stringify(claim)))
      return { type: 'e2e_pw_pake', payload: { sid: pr.sidB64, round: 4, enc: C.b64e(sealed) } }
    }
    return null // round 5 (ok/error) — nothing to send
  }
}

function machine(extra: Partial<ConstructorParameters<typeof makeManager>[0]> = {}) {
  const sent: Array<{ connId: string; frame: Frame }> = []
  const mgr = new makeManager({ machineId: AGENT, sendTo: (connId, frame) => sent.push({ connId, frame }), isConnected: () => true, ...extra })
  const takeLast = (type: string): Frame => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].frame.type === type) return sent[i].frame
    throw new Error(`no ${type} sent`)
  }
  const lastFor = (connId: string, type: string): Frame | undefined => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].connId === connId && sent[i].frame.type === type) return sent[i].frame
    return undefined
  }
  return { mgr, sent, takeLast, lastFor }
}

/** Drive a full pairing + session for one connection; returns the established web peer. */
async function fullPair(h: ReturnType<typeof machine>, conn: string, role: 'web' | 'device' = 'web'): Promise<WebPeer> {
  const web = new WebPeer(role)
  h.mgr.handleFrame(conn, web.intent(C.newPairId()))
  const code = C.newPairCode(); web.setCode(code)
  const pairP = h.mgr.onPair(code)
  h.mgr.handleFrame(conn, web.onPake(h.lastFor(conn, 'e2e_pake')!)!) // r2 → r3
  h.mgr.handleFrame(conn, web.onPake(h.lastFor(conn, 'e2e_pake')!)!) // r4 → r5
  await pairP
  h.mgr.handleFrame(conn, web.hello())
  web.onWelcome(h.lastFor(conn, 'e2e_welcome')!, web.adapterPub!)
  return web
}

describe('E2eeManager pairing', () => {
  it('a trusted browser pairs a phone and receives an encrypted result', async () => {
    const h = machine()
    const browser = await fullPair(h, 'browser')
    const phone = new WebPeer()
    const code = 'ABCDEFGHJKMNPQRS'
    h.mgr.handleFrame('phone', phone.intent(C.newPairId()))
    phone.setCode(code)
    const pairing = h.mgr.pairPhoneFromTrustedWeb('browser', { requestId: 'phone-link', code })
    h.mgr.handleFrame('phone', phone.onPake(h.lastFor('phone', 'e2e_pake')!)!)
    h.mgr.handleFrame('phone', phone.onPake(h.lastFor('phone', 'e2e_pake')!)!)
    await pairing
    const answer = h.lastFor('browser', 'phone_pair_result')!
    expect(C.isWrapped(answer.payload)).toBe(true)
    const opened = C.unwrapPayload(browser.session!.s2c,
      (answer.payload as import('./core.js').WrappedPayload).__e2e, 'phone_pair_result', undefined)
    expect(opened).toMatchObject({ requestId: 'phone-link', ok: true, label: 'Chrome · macOS' })
    h.mgr.handleFrame('phone', phone.hello())
    phone.onWelcome(h.lastFor('phone', 'e2e_welcome')!, phone.adapterPub!)
    expect(h.mgr.hasSession('phone')).toBe(true)
  })

  it('unpaired visitors and hardware devices cannot authorize a phone', async () => {
    const h = machine()
    await fullPair(h, 'device', 'device')
    const phone = new WebPeer()
    h.mgr.handleFrame('phone', phone.intent(C.newPairId()))
    const before = h.sent.length
    for (const conn of ['anonymous', 'device']) {
      await h.mgr.pairPhoneFromTrustedWeb(conn, { requestId: 'r', code: 'ABCDEFGHJKMNPQRS' })
    }
    expect(h.sent).toHaveLength(before)
    expect(h.mgr.hasSession('phone')).toBe(false)
    h.mgr.dropSession('phone')
  })

  it('phone authorization does not arm hardware intents or accept malformed codes', async () => {
    const h = machine()
    const browser = await fullPair(h, 'browser')
    const read = () => C.unwrapPayload(browser.session!.s2c,
      (h.lastFor('browser', 'phone_pair_result')!.payload as import('./core.js').WrappedPayload).__e2e, 'phone_pair_result', undefined)
    await h.mgr.pairPhoneFromTrustedWeb('browser', { code: 'short' })
    expect(read()).toMatchObject({ error: 'BAD_CODE' })
    await h.mgr.pairPhoneFromTrustedWeb('browser', { code: 'ABCDEFGHJKMNPQRS' })
    expect(read()).toMatchObject({ error: 'NO_INTENT' })
    h.mgr.handleFrame('device', new WebPeer('device').intent(C.newPairId()))
    await h.mgr.pairPhoneFromTrustedWeb('browser', { code: 'ABCDEFGHJKMNPQRS' })
    expect(read()).toMatchObject({ error: 'NO_INTENT' })
    expect(h.lastFor('device', 'e2e_pake')).toBeUndefined()
    h.mgr.dropSession('device')
  })

  it('pairs nobody from an e2e_setup_claim — browser setup links were removed with the web client', () => {
    const { mgr, sent } = machine()
    const web = new WebPeer()
    mgr.handleFrame('claim-1', { type: 'e2e_setup_claim', payload: { requestId: 'r', token: 'x', identityPub: C.b64e(web.identity.pub), sig: 'x' } })
    expect(mgr.listPaired()).toEqual([])
    expect(sent.some((s) => s.frame.type === 'e2e_setup_claim_result')).toBe(false)
  })

  it('completes a full pairing, pins the browser, and establishes a session + group key', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    const conn = 'conn1'
    const pairId = C.newPairId()

    mgr.handleFrame(conn, web.intent(pairId))
    expect((takeLast('e2e_pair_intent_result').payload as Record<string, unknown>).accepted).toBe(true)

    const code = C.newPairCode()
    web.setCode(code)
    const pairP = mgr.onPair(code)                          // sends round 1
    const r2 = web.onPake(takeLast('e2e_pake'))!            // → round 2
    mgr.handleFrame(conn, r2)                               // → round 3
    const r4 = web.onPake(takeLast('e2e_pake'))!            // → round 4
    mgr.handleFrame(conn, r4)                               // → round 5 + resolves
    const result = await pairP
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fingerprint).toBe(mgr.fingerprint())

    // session: hello → welcome
    mgr.handleFrame(conn, web.hello())
    const welcome = takeLast('e2e_welcome')
    expect(mgr.hasSession(conn)).toBe(true)
    web.onWelcome(welcome, web.adapterPub!) // adapter pub was pinned by the web during round 3

    const up = mgr.wrapUp({ type: 'text_delta', dbSessionId: 'sX', payload: { content: 'hello user' } })
    const env = (up.payload as import('./core.js').WrappedPayload).__e2e
    expect(env.k).toBe('g')
    const dec = C.unwrapPayload(web.session!.groupKey, env, 'text_delta', 'sX')
    expect(dec).toEqual({ content: 'hello user' })

    // down message: web encrypts under c2s → manager decrypts
    const wrapped = C.wrapPayload(web.session!.c2s, 'p', 0, 'message', undefined, { content: 'fix the bug' })
    const down = mgr.unwrapDown(conn, { type: 'message', payload: wrapped })
    expect((down!.payload as Record<string, unknown>).content).toBe('fix the bug')

    // Same path for an AskUserQuestion answer — the device wraps it, so the answers must survive the trip
    // intact. When they did not, the CLI dropped the frame and the pane's dialog was never keyed.
    const qw = C.wrapPayload(web.session!.c2s, 'p', 1, 'question_response', undefined,
      { requestId: 'q1', sessionId: 'sX', answers: { color: 'Xanh' } })
    const qdown = mgr.unwrapDown(conn, { type: 'question_response', payload: qw })
    expect((qdown!.payload as Record<string, unknown>).answers).toEqual({ color: 'Xanh' })

    // Plaintext is never opened into a request: it came from the relay, not from the paired client.
    expect(mgr.unwrapDown(conn, { type: 'message', payload: { content: 'from the relay', agentId: 'a1' } })).toBeNull()
    expect(mgr.unwrapDown('no-session', { type: 'message', payload: wrapped })).toBeNull()
  })

  it('rejects a wrong code at the confirmation MAC (round 2)', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    const conn = 'c2'
    mgr.handleFrame(conn, web.intent(C.newPairId()))
    const realCode = C.newPairCode()
    web.setCode('BADCOD')                 // web believes a different code
    const pairP = mgr.onPair(realCode)    // adapter uses the real code
    const r2 = web.onPake(takeLast('e2e_pake'))!
    mgr.handleFrame(conn, r2)
    const result = await pairP
    expect(result).toEqual({ ok: false, error: 'CODE_MISMATCH' })
    const last = takeLast('e2e_pake').payload as Record<string, unknown>
    expect(last.error).toBe('CODE_MISMATCH')
  })

  it('e2e_status reports supported + enabled + not-paired for an unknown browser', () => {
    const { mgr, takeLast } = machine()
    const id = C.newIdentity()
    mgr.handleFrame('c3', { type: 'e2e_status', payload: { requestId: 'q', identityPub: C.b64e(id.pub) } })
    const r = takeLast('e2e_status_result').payload as Record<string, unknown>
    expect(r).toMatchObject({ supported: true, enabled: true, paired: false })
    expect(typeof r.fingerprint).toBe('string')
  })

  it('rejects a hello from an unpaired identity with e2e_denied', () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    mgr.handleFrame('c4', web.hello())
    expect((takeLast('e2e_denied').payload as Record<string, unknown>).reason).toBe('unpaired')
    expect(mgr.hasSession('c4')).toBe(false)
  })

  describe('a hello from a key the device key log may name (onUnknownHello)', () => {
    /** A signed-in browser this machine has not trusted yet: the hook stands for the log's read. */
    const label = 'Chrome · macOS'

    it('waits for the log to trust the key, then opens the session', async () => {
      const web = new WebPeer()
      const seen: string[] = []
      const h = machine({
        onUnknownHello: async (pub) => { seen.push(pub); h.mgr.trustPeer({ pub, label, kind: 'viewer' }) },
      })
      h.mgr.handleFrame('w1', web.hello())
      await vi.waitFor(() => expect(h.lastFor('w1', 'e2e_welcome')).toBeTruthy())
      expect(seen).toEqual([C.b64e(web.identity.pub)])
      expect(h.lastFor('w1', 'e2e_denied')).toBeUndefined()
      const machinePub = (JSON.parse(readFileSync(join(process.env.ADAPTER_DATA_DIR as string, 'e2e', 'identity.json'), 'utf8')) as { pub: string }).pub
      web.onWelcome(h.lastFor('w1', 'e2e_welcome')!, C.b64d(machinePub))
      expect(h.mgr.hasSession('w1')).toBe(true)
    })

    it('denies the hello as unpaired when the log does not trust the key within the bound', async () => {
      vi.useFakeTimers()
      try {
        const h = machine({ onUnknownHello: () => new Promise<void>(() => {}) })
        h.mgr.handleFrame('w2', new WebPeer().hello())
        await vi.advanceTimersByTimeAsync(3_999)
        expect(h.lastFor('w2', 'e2e_denied')).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect((h.lastFor('w2', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('unpaired')
        expect(h.mgr.hasSession('w2')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('denies at once, as unpaired, when the read fails', async () => {
      const h = machine({ onUnknownHello: async () => { throw new Error('offline') } })
      h.mgr.handleFrame('w3', new WebPeer().hello())
      await vi.waitFor(() => expect(h.lastFor('w3', 'e2e_denied')).toBeTruthy())
      expect((h.lastFor('w3', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('unpaired')
    })

    it('never reads the log for a hello whose signature does not verify', () => {
      const hook = vi.fn(async () => {})
      const h = machine({ onUnknownHello: hook })
      const hello = new WebPeer().hello()
      ;(hello.payload as Record<string, unknown>).sig = C.b64e(new Uint8Array(64))
      h.mgr.handleFrame('w4', hello)
      expect(hook).not.toHaveBeenCalled()
      expect((h.lastFor('w4', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('bad_sig')
    })

    it('drops the answer to a hello a newer one on the same connection replaced', async () => {
      const web = new WebPeer()
      const pending: Array<() => void> = []
      const h = machine({ onUnknownHello: (pub) => new Promise<void>((resolve) => pending.push(() => { h.mgr.trustPeer({ pub, label }); resolve() })) })
      h.mgr.handleFrame('w5', web.hello())
      const first = C.b64e(web.session!.myEph.pub)
      h.mgr.handleFrame('w5', web.hello())
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      // The first read trusts the key; the hello it was for is not answered, the newer one still waits.
      pending[0]()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.sent.filter((s) => s.connId === 'w5')).toEqual([])
      pending[1]()
      await vi.waitFor(() => expect(h.lastFor('w5', 'e2e_welcome')).toBeTruthy())
      const answers = h.sent.filter((s) => s.connId === 'w5')
      expect(answers).toHaveLength(1)
      expect((answers[0].frame.payload as Record<string, unknown>).webEphPub).toBe(C.b64e(web.session!.myEph.pub))
      expect((answers[0].frame.payload as Record<string, unknown>).webEphPub).not.toBe(first)
    })

    it('answers nothing for a connection that went while its hello waited', async () => {
      let release: () => void = () => {}
      const h = machine({ onUnknownHello: (pub) => new Promise<void>((resolve) => { release = () => { h.mgr.trustPeer({ pub, label }); resolve() } }) })
      h.mgr.handleFrame('w6', new WebPeer().hello())
      h.mgr.dropSession('w6')
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.sent.filter((s) => s.connId === 'w6')).toEqual([])
      expect(h.mgr.hasSession('w6')).toBe(false)
    })

    it('answers a paired key at once, without reading the log', () => {
      const hook = vi.fn(async () => {})
      const h = machine({ onUnknownHello: hook })
      const web = new WebPeer()
      h.mgr.trustPeer({ pub: C.b64e(web.identity.pub), label })
      h.mgr.handleFrame('w7', web.hello())
      expect(h.lastFor('w7', 'e2e_welcome')).toBeTruthy()
      expect(hook).not.toHaveBeenCalled()
    })
  })

  it('a second concurrent pair_intent is rejected as PAIRING_BUSY while active', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    mgr.handleFrame('c5', web.intent(C.newPairId()))
    mgr.onPair(C.newPairCode()) // becomes active (round 1 out)
    mgr.handleFrame('c6', { type: 'e2e_pair_intent', payload: { requestId: 'r2', pairId: C.b64e(C.newPairId()), label: 'x' } })
    expect((takeLast('e2e_pair_intent_result').payload as Record<string, unknown>).error).toBe('PAIRING_BUSY')
  })
})

describe('E2eeManager revoke', () => {
  it('lists paired browsers with fingerprint + online flag', async () => {
    const h = machine()
    const web = await fullPair(h, 'cx')
    const list = h.mgr.listPaired()
    expect(list.length).toBe(1)
    expect(list[0].online).toBe(true)
    expect(list[0].fingerprint).toBe(C.fingerprint(web.identity.pub))
  })

  it('revoke: signals the online browser (e2e_denied), rotates the group key, drops the pin', async () => {
    const h = machine()
    const conn = 'cy'
    const web = await fullPair(h, conn)
    const oldGroupKey = web.session!.groupKey
    const before = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'pre' } })
    const oldEpoch = (before.payload as import('./core.js').WrappedPayload).__e2e.epoch

    const r = h.mgr.revoke('1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fingerprint).toBe(C.fingerprint(web.identity.pub))
    // the online session got a revoke signal
    expect(h.lastFor(conn, 'e2e_denied')).toBeTruthy()
    expect((h.lastFor(conn, 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('revoked')
    // store emptied, session dropped
    expect(h.mgr.listPaired().length).toBe(0)
    expect(h.mgr.hasSession(conn)).toBe(false)
    // group key rotated → new epoch, and the revoked browser's OLD key can't decrypt new events
    const after = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'post' } })
    const newEnv = (after.payload as import('./core.js').WrappedPayload).__e2e
    expect(newEnv.epoch).not.toBe(oldEpoch)
    expect(C.unwrapPayload(oldGroupKey, newEnv, 'text_delta', 's')).toBeNull()
  })

  it('a reconnect hello from a revoked identity is answered with e2e_denied (unpaired)', async () => {
    const h = machine()
    const web = await fullPair(h, 'cr')
    expect(h.mgr.revoke(C.fingerprint(web.identity.pub)).ok).toBe(true)
    h.mgr.handleFrame('cr2', web.hello())
    expect((h.lastFor('cr2', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('unpaired')
    expect(h.mgr.hasSession('cr2')).toBe(false)
  })

  it('revoke-all runs onIdentityRevoked while the session is still live, so a device frame can be sealed', async () => {
    const live: boolean[] = []
    const h = machine({ onIdentityRevoked: () => live.push(h.mgr.hasSession('ra')) })
    await fullPair(h, 'ra')
    h.mgr.revokeAll()
    expect(live).toEqual([true])
    expect(h.mgr.hasSession('ra')).toBe(false)
  })

  it('revoke re-keys the REMAINING browsers so they keep decrypting', async () => {
    const h = machine()
    const web1 = await fullPair(h, 'a1')
    const web2 = await fullPair(h, 'a2')
    // revoke web1 (list is sorted by pairedAt desc; select by fingerprint to be exact)
    const r = h.mgr.revoke(C.fingerprint(web1.identity.pub))
    expect(r.ok).toBe(true)
    expect((h.lastFor('a1', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('revoked')
    // web2 received a rekey → apply it → can still decrypt the next event
    web2.onRekey(h.lastFor('a2', 'e2e_rekey')!)
    const after = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'still ok' } })
    const env = (after.payload as import('./core.js').WrappedPayload).__e2e
    expect(C.unwrapPayload(web2.session!.groupKey, env, 'text_delta', 's')).toEqual({ content: 'still ok' })
    expect(h.mgr.listPaired().length).toBe(1)
  })

  it('revoke-all clears every pair and denies every session', async () => {
    const h = machine()
    await fullPair(h, 'z1')
    await fullPair(h, 'z2')
    const r = h.mgr.revokeAll()
    expect(r.count).toBe(2)
    expect(h.mgr.listPaired().length).toBe(0)
    expect(h.lastFor('z1', 'e2e_denied')).toBeTruthy()
    expect(h.lastFor('z2', 'e2e_denied')).toBeTruthy()
    expect(h.mgr.hasSession('z1')).toBe(false)
    expect(h.mgr.hasSession('z2')).toBe(false)
  })

  it('reloadPaired: a key another account\'s stores left out loses its session; the rest keep theirs, re-keyed', async () => {
    const h = machine()
    const gone = await fullPair(h, 'k1')
    const kept = await fullPair(h, 'k2')
    await fullPair(h, 'kd', 'device')
    // What accountTrust.ts leaves on disk: the account's browsers put away, the Wi-Fi device kept.
    const file = join(process.env.ADAPTER_DATA_DIR as string, 'e2e', 'paired.json')
    const pairs = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ identityPub: string }>
    writeFileSync(file, JSON.stringify(pairs.filter((p) => p.identityPub !== C.b64e(gone.identity.pub))))
    h.mgr.reloadPaired()
    expect((h.lastFor('k1', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('revoked')
    expect(h.mgr.hasSession('k1')).toBe(false)
    expect(h.mgr.hasSession('k2')).toBe(true)
    expect(h.mgr.hasSession('kd')).toBe(true)
    expect(h.mgr.listPaired().map((p) => p.role).sort()).toEqual(['device', 'web'])
    kept.onRekey(h.lastFor('k2', 'e2e_rekey')!)
    const env = (h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'b' } }).payload as import('./core.js').WrappedPayload).__e2e
    expect(C.unwrapPayload(kept.session!.groupKey, env, 'text_delta', 's')).toEqual({ content: 'b' })
    expect(C.unwrapPayload(gone.session!.groupKey, env, 'text_delta', 's')).toBeNull()
  })

  it('revoke NOT_FOUND for an unknown selector', async () => {
    const h = machine()
    await fullPair(h, 'q1')
    expect(h.mgr.revoke('ZZZZ')).toEqual({ ok: false, error: 'NOT_FOUND' })
  })
})

// Every case here runs at least one real scrypt in the manager (`setRemotePassword`) and one for its
// joiner: PW_SCRYPT_TEST_TIMEOUT_MS, the budget the lockout cases already carried, for all of them.
describe('E2eeManager persistent remote-password pairing', { timeout: PW_SCRYPT_TEST_TIMEOUT_MS }, () => {
  const PASSWORD = 'correct horse battery staple'

  it('NO_REMOTE_PASSWORD when no password has been set', async () => {
    const { mgr, takeLast } = machine()
    const joiner = new PwPeer()
    mgr.handleFrame('pw1', await joiner.intent(PASSWORD))
    const result = takeLast('e2e_pw_pair_result').payload as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, error: 'NO_REMOTE_PASSWORD' })
  })

  it('completes a full password pairing with no human "arm" step, pins the joiner, and reports status', async () => {
    const { mgr, takeLast } = machine()
    expect(mgr.remotePasswordStatus()).toEqual({ hasPassword: false, fingerprint: null, setAt: null })
    const set = await mgr.setRemotePassword(PASSWORD)
    expect(mgr.remotePasswordStatus()).toMatchObject({ hasPassword: true, fingerprint: set.fingerprint })
    expect(mgr.remotePasswordStatus().setAt).toEqual(expect.any(Number))

    const joiner = new PwPeer()
    const conn = 'pw2'
    mgr.handleFrame(conn, await joiner.intent(PASSWORD)) // → round 1, no local approval needed
    const r2 = joiner.onPake(takeLast('e2e_pw_pake'))!
    mgr.handleFrame(conn, r2)                             // → round 3
    const r4 = joiner.onPake(takeLast('e2e_pw_pake'))!
    mgr.handleFrame(conn, r4)                             // → round 5

    const final = takeLast('e2e_pw_pake').payload as Record<string, unknown>
    expect(final).toMatchObject({ round: 5, ok: true, fingerprint: mgr.fingerprint() })
    // Pinned exactly as onSetupClaim pins a browser — same role, same trust surface.
    const paired = mgr.listPaired()
    expect(paired.length).toBe(1)
    expect(paired[0]).toMatchObject({ fingerprint: C.fingerprint(joiner.identity.pub), label: 'harness link', role: 'web' })
  })

  it('a joiner that names itself is listed by that name — one clean line of it', async () => {
    const { mgr, takeLast } = machine()
    await mgr.setRemotePassword(PASSWORD)
    for (const [conn, label, shown] of [
      ['pw-a', "Dee's iPhone", "Dee's iPhone"],
      ['pw-b', '  two\nlines\u0007 ', 'two lines'],
      ['pw-c', 'x'.repeat(90), 'x'.repeat(60)],
      ['pw-d', '   ', 'harness link'],
    ] as const) {
      const joiner = new PwPeer()
      joiner.label = label
      mgr.handleFrame(conn, await joiner.intent(PASSWORD))
      mgr.handleFrame(conn, joiner.onPake(takeLast('e2e_pw_pake'))!)
      mgr.handleFrame(conn, joiner.onPake(takeLast('e2e_pw_pake'))!)
      expect(mgr.listPaired().find((p) => p.fingerprint === C.fingerprint(joiner.identity.pub))?.label).toBe(shown)
    }
    // Four real password handshakes need the same scrypt budget as the lockout cases.
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

  it('a wrong password fails the confirmation MAC at round 2 and pins nobody', async () => {
    const { mgr, takeLast } = machine()
    await mgr.setRemotePassword(PASSWORD)
    const joiner = new PwPeer()
    const conn = 'pw3'
    mgr.handleFrame(conn, await joiner.intent('not the right password'))
    const r2 = joiner.onPake(takeLast('e2e_pw_pake'))!
    mgr.handleFrame(conn, r2)
    const final = takeLast('e2e_pw_pake').payload as Record<string, unknown>
    expect(final).toMatchObject({ round: 5, error: 'WRONG_PASSWORD' })
    expect(mgr.listPaired().length).toBe(0)
  })

  it('locks out after repeated wrong passwords, rejecting further intents before any crypto runs', async () => {
    const { mgr, takeLast } = machine()
    await mgr.setRemotePassword(PASSWORD)
    for (let i = 0; i < 5; i++) {
      const joiner = new PwPeer()
      const conn = `pwbad${i}`
      mgr.handleFrame(conn, await joiner.intent(`wrong-${i}`))
      const r2 = joiner.onPake(takeLast('e2e_pw_pake'))!
      mgr.handleFrame(conn, r2)
    }
    // The 6th attempt, even with the CORRECT password, must be rejected as RATE_LIMITED with no
    // e2e_pw_pake round-1 frame ever sent — proving the lockout is checked before any CPace runs.
    const joiner = new PwPeer()
    mgr.handleFrame('pwlocked', await joiner.intent(PASSWORD))
    const result = takeLast('e2e_pw_pair_result').payload as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, error: 'RATE_LIMITED' })
    expect(typeof result.retryAt).toBe('number')
    // One scrypt per wrong-password attempt — see PW_SCRYPT_TEST_TIMEOUT_MS.
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

  it('setting a new password clears an existing lockout', async () => {
    const { mgr, takeLast } = machine()
    await mgr.setRemotePassword(PASSWORD)
    for (let i = 0; i < 5; i++) {
      const joiner = new PwPeer()
      const conn = `pwbad2-${i}`
      mgr.handleFrame(conn, await joiner.intent(`wrong-${i}`))
      const r2 = joiner.onPake(takeLast('e2e_pw_pake'))!
      mgr.handleFrame(conn, r2)
    }
    const stillLocked = new PwPeer()
    mgr.handleFrame('pwstilllocked', await stillLocked.intent(PASSWORD))
    expect((takeLast('e2e_pw_pair_result').payload as Record<string, unknown>).error).toBe('RATE_LIMITED')

    await mgr.setRemotePassword('a brand new remote password')
    const joiner = new PwPeer()
    const conn = 'pwfresh'
    mgr.handleFrame(conn, await joiner.intent('a brand new remote password'))
    const r2 = joiner.onPake(takeLast('e2e_pw_pake'))!
    mgr.handleFrame(conn, r2)
    const r4 = joiner.onPake(takeLast('e2e_pw_pake'))!
    mgr.handleFrame(conn, r4)
    expect(takeLast('e2e_pw_pake').payload).toMatchObject({ round: 5, ok: true })
    // One scrypt per wrong-password attempt — see PW_SCRYPT_TEST_TIMEOUT_MS.
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

  it('keeps at most two password attempts in flight at once; a third is BUSY until one finishes', async () => {
    const { mgr, takeLast, lastFor } = machine()
    await mgr.setRemotePassword(PASSWORD)
    const a = new PwPeer(), b = new PwPeer(), c = new PwPeer()
    mgr.handleFrame('slot-a', await a.intent(PASSWORD))
    mgr.handleFrame('slot-b', await b.intent(PASSWORD))
    mgr.handleFrame('slot-c', await c.intent(PASSWORD))
    expect(lastFor('slot-c', 'e2e_pw_pair_result')?.payload).toMatchObject({ ok: false, error: 'BUSY' })
    expect(lastFor('slot-c', 'e2e_pw_pake')).toBeUndefined()
    // One finishing frees its place.
    mgr.handleFrame('slot-a', a.onPake(lastFor('slot-a', 'e2e_pw_pake')!)!)
    mgr.handleFrame('slot-a', a.onPake(lastFor('slot-a', 'e2e_pw_pake')!)!)
    expect(lastFor('slot-a', 'e2e_pw_pake')?.payload).toMatchObject({ round: 5, ok: true })
    const d = new PwPeer()
    mgr.handleFrame('slot-d', await d.intent(PASSWORD))
    expect(takeLast('e2e_pw_pake').payload).toMatchObject({ round: 1 })
  })

  it('judges an attempt against a lockout that began after its intent, without evaluating it', async () => {
    const { mgr, lastFor } = machine()
    await mgr.setRemotePassword(PASSWORD)
    const held = new PwPeer()
    mgr.handleFrame('held', await held.intent(PASSWORD))
    const heldRound1 = lastFor('held', 'e2e_pw_pake')!
    for (let i = 0; i < 5; i++) {
      const joiner = new PwPeer()
      const conn = `pwlock-${i}`
      mgr.handleFrame(conn, await joiner.intent(`wrong-${i}`))
      mgr.handleFrame(conn, joiner.onPake(lastFor(conn, 'e2e_pw_pake')!)!)
    }
    // Now locked. The attempt opened before the lockout — even with the right password — is refused.
    mgr.handleFrame('held', held.onPake(heldRound1)!)
    expect(lastFor('held', 'e2e_pw_pake')?.payload).toMatchObject({ round: 5, error: 'RATE_LIMITED', retryAt: expect.any(Number) })
    expect(mgr.listPaired()).toEqual([])
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

  it('starts the lockout backoff over after a success, and after a quiet day', async () => {
    const { mgr, lastFor } = machine()
    await mgr.setRemotePassword(PASSWORD)
    const lockNow = async (tag: string): Promise<number> => {
      for (let i = 0; i < 5; i++) {
        const joiner = new PwPeer()
        const conn = `${tag}-${i}`
        mgr.handleFrame(conn, await joiner.intent(`wrong-${i}`))
        mgr.handleFrame(conn, joiner.onPake(lastFor(conn, 'e2e_pw_pake')!)!)
      }
      const probe = new PwPeer()
      mgr.handleFrame(`${tag}-probe`, await probe.intent(PASSWORD))
      return (lastFor(`${tag}-probe`, 'e2e_pw_pair_result')!.payload as { retryAt: number }).retryAt
    }
    const FIVE_MIN = 5 * 60_000
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let now = Date.now()
      expect(await lockNow('first') - now).toBeLessThanOrEqual(FIVE_MIN + 1000)
      // Right after it ends, the next lockout escalates (10 min)…
      vi.setSystemTime(now += FIVE_MIN + 1000)
      expect(await lockNow('second') - now).toBeGreaterThan(FIVE_MIN + 1000)
      // …but a day of quiet since the last one ended starts it over.
      vi.setSystemTime(now += 10 * FIVE_MIN + 25 * 60 * 60_000)
      expect(await lockNow('third') - now).toBeLessThanOrEqual(FIVE_MIN + 1000)
    } finally { vi.useRealTimers() }
  }, PW_SCRYPT_TEST_TIMEOUT_MS * 3)

  it('clearRemotePassword removes it — a subsequent intent gets NO_REMOTE_PASSWORD again', async () => {
    const { mgr, takeLast } = machine()
    await mgr.setRemotePassword(PASSWORD)
    mgr.clearRemotePassword()
    expect(mgr.remotePasswordStatus()).toEqual({ hasPassword: false, fingerprint: null, setAt: null })
    const joiner = new PwPeer()
    mgr.handleFrame('pwcleared', await joiner.intent(PASSWORD))
    expect(takeLast('e2e_pw_pair_result').payload).toMatchObject({ ok: false, error: 'NO_REMOTE_PASSWORD' })
  })
})

describe('a sealed frame for a session this process never had', () => {
  const sealed = { type: 'message', payload: { __e2e: { v: 1, k: 'p', n: 7, ct: 'AAAA' } } }

  it('tells the client its session is gone, naming the frame, at most once a second per connection', () => {
    let now = 1_000
    const mgr = new makeManager({ machineId: AGENT, sendTo: () => {}, isConnected: () => true }, () => now)
    expect(mgr.sessionGone('conn-old', sealed)).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'message', n: 7 } } })
    expect(mgr.sessionGone('conn-old', sealed)).toBeNull()
    now += 999
    expect(mgr.sessionGone('conn-old', sealed)).toBeNull()
    now += 1
    expect(mgr.sessionGone('conn-old', sealed)).not.toBeNull()
    // Another connection is its own; a frame with no counter to name is named by its type.
    expect(mgr.sessionGone('conn-other', { type: 'agents_list', payload: { __e2e: { n: 'x' } } })).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'agents_list' } } })
    expect(mgr.sessionGone('conn-bare', { type: 'agents_list' })).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'agents_list' } } })
  })

  it('says nothing to a connection that has a session: a frame that does not open there is the relay\'s', () => {
    const h = machine()
    const peer = new WebPeer()
    h.mgr.trustPeer({ pub: C.b64e(peer.identity.pub), label: 'phone' })
    h.mgr.handleFrame('live', peer.hello())
    expect(h.mgr.hasSession('live')).toBe(true)
    expect(h.mgr.sessionGone('live', sealed)).toBeNull()
  })

  it('remembers a bounded number of the connections it told, the oldest let go first', () => {
    const mgr = new makeManager({ machineId: AGENT, sendTo: () => {}, isConnected: () => true }, () => 5_000)
    for (let n = 0; n <= 256; n++) expect(mgr.sessionGone(`conn-${n}`, sealed)).not.toBeNull()
    // The first was let go, so it is told again at once; the last is still remembered.
    expect(mgr.sessionGone('conn-0', sealed)).not.toBeNull()
    expect(mgr.sessionGone('conn-256', sealed)).toBeNull()
  })
})

describe('terminal bytes sealed for a session this process never had', () => {
  const keystrokes = async (counter: number) => {
    const { sealTerminalBinary } = await import('./terminalSeal.js')
    return sealTerminalBinary(new Uint8Array(32).fill(9), counter, { kind: 1, streamId: '00112233-4455-6677-8899-aabbccddeeff', seq: 1, bytes: new TextEncoder().encode('ls\r'), compressed: false })!
  }

  it('tells the client its session is gone, naming the bytes by their clear kind and counter', async () => {
    const mgr = new makeManager({ machineId: AGENT, sendTo: () => {}, isConnected: () => true }, () => 1_000)
    expect(mgr.terminalSessionGone('conn-old', await keystrokes(5))).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'terminal_binary', kind: 1, n: 5 } } })
    // Bytes that are not a terminal frame at all are named by what they claim to be.
    expect(mgr.terminalSessionGone('conn-garbled', new Uint8Array([1, 2, 3]))).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'terminal_binary' } } })
  })

  it('shares the once-a-second allowance per connection with sealed frames', async () => {
    let now = 1_000
    const mgr = new makeManager({ machineId: AGENT, sendTo: () => {}, isConnected: () => true }, () => now)
    expect(mgr.sessionGone('conn-old', { type: 'message', payload: { __e2e: { n: 1 } } })).not.toBeNull()
    expect(mgr.terminalSessionGone('conn-old', await keystrokes(2))).toBeNull()
    now += 1_000
    expect(mgr.terminalSessionGone('conn-old', await keystrokes(3))).not.toBeNull()
  })

  it('says nothing to a connection that has a session', async () => {
    const h = machine()
    const peer = new WebPeer()
    h.mgr.trustPeer({ pub: C.b64e(peer.identity.pub), label: 'phone' })
    h.mgr.handleFrame('live', peer.hello())
    expect(h.mgr.terminalSessionGone('live', await keystrokes(4))).toBeNull()
  })
})
