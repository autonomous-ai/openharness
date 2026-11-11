import { describe, expect, it } from 'vitest'
// @ts-expect-error — the tool server's helpers are plain ESM, run by Node inside the browser's container.
import { CHALLENGE_ELEMENTS, detectChallenge, frameKind, withChallenge } from '../../../assets/browser/challenge.mjs'

const shown = (url: string) => ({ url, visible: true, width: 300, height: 150 })
const LINE = 'This page asks for a person. Tell your person in chat what to do in Browser, wait for their answer, and do not act on the challenge yourself.'

describe('detectChallenge', () => {
  it.each([
    ['recaptcha', 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=key'],
    ['recaptcha', 'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=key'],
    ['hcaptcha', 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge'],
    ['cloudflare', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0x4AAA/auto/normal/auto/'],
    ['datadome', 'https://geo.captcha-delivery.com/captcha/?initialCid=abc&hash=def'],
    ['arkose', 'https://client-api.arkoselabs.com/fc/gc/?token=abc'],
    ['arkose', 'https://funcaptcha.com/fc/api/nojs/?pkey=abc'],
  ])('each challenge kind is detected from its visible frame: %s', (kind, url) => {
    expect(detectChallenge([shown('https://ads.example/frame'), shown(url)], [])).toBe(kind)
  })

  it.each([['#px-captcha', 'perimeterx'], ['awswaf-captcha', 'awswaf']])('each challenge kind is detected from its visible element: %s', (selector, kind) => {
    expect([...CHALLENGE_ELEMENTS.keys()]).toContain(selector)
    expect(detectChallenge([], [selector])).toBe(kind)
  })

  it('the word captcha in page text is not a challenge', () => {
    expect(detectChallenge([shown('https://news.example/how-captcha-works?ref=hcaptcha.com')], ['Solve the captcha', 'constructor'])).toBeNull()
  })

  it('an invisible or zero-size frame is not a challenge', () => {
    const url = 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge'
    expect(detectChallenge([{ url, visible: false, width: 400, height: 600 }], [])).toBeNull()
    expect(detectChallenge([{ url, visible: true, width: 0, height: 0 }], [])).toBeNull()
    expect(detectChallenge([{ url, visible: true, width: 1, height: 1 }], [])).toBeNull()
  })

  it('the badge of an invisible reCAPTCHA is not a challenge', () => {
    expect(detectChallenge([shown('https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible')], [])).toBeNull()
  })

  it('a page with none finds none; a frame without a URL is skipped', () => {
    expect(detectChallenge([], [])).toBeNull()
    expect(frameKind('')).toBeNull()
    expect(frameKind('about:blank')).toBeNull()
  })
})

describe('withChallenge', () => {
  const reply = { content: [{ type: 'text', text: 'https://shop.example/ · Shop' }] }

  it('a detected challenge is added to the tool reply with the chat line', () => {
    expect(withChallenge(reply, 'cloudflare')).toEqual({
      content: [{ type: 'text', text: 'https://shop.example/ · Shop' }, { type: 'text', text: `challenge: cloudflare\n${LINE}` }],
    })
  })

  it('a page with none adds nothing', () => {
    expect(withChallenge(reply, null)).toBe(reply)
  })
})
