// A page that needs a person: the tool server reads the page's frames and a few elements, and this decides, with no
// browser, whether one of them is a challenge a person must answer (signs from the prior art's captcha handoff).

// A frame a person can act on is larger than this; tracking frames and invisible-mode widgets are 0 or 1 px.
const MIN_PX = 10

const LINE = 'This page asks for a person. Tell your person in chat what to do in Browser, wait for their answer, and do not act on the challenge yourself.'

// Elements by CSS selector, for challenges that draw into the page rather than into a frame of their own.
export const CHALLENGE_ELEMENTS = new Map([
  ['#px-captcha', 'perimeterx'],
  ['awswaf-captcha', 'awswaf'],
])

const HOSTS = [
  ['hcaptcha.com', 'hcaptcha'],
  ['challenges.cloudflare.com', 'cloudflare'],
  ['captcha-delivery.com', 'datadome'],
  ['arkoselabs.com', 'arkose'],
  ['funcaptcha.com', 'arkose'],
]

/** The kind of challenge a frame's URL serves, or null. By host, so a page's own URL that names one never counts. */
export function frameKind(url) {
  let parsed
  try { parsed = new URL(url) } catch { return null }
  // reCAPTCHA's badge and checkbox are its anchor frame, always on a page that uses it; the bframe is the challenge.
  if (/\/recaptcha\/.*bframe/.test(parsed.pathname)) return 'recaptcha'
  const host = parsed.hostname
  return HOSTS.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? null
}

/** `frames`: the page's subframes with their owner element's box; `elements`: the selectors with a visible element. */
export function detectChallenge(frames, elements) {
  for (const frame of frames) {
    const kind = frameKind(frame.url)
    if (kind && frame.visible && frame.width >= MIN_PX && frame.height >= MIN_PX) return kind
  }
  return elements.map(selector => CHALLENGE_ELEMENTS.get(selector)).find(Boolean) ?? null
}

/** The tool reply, with the challenge and the one line that tells the agent to ask its person. */
export function withChallenge(reply, kind) {
  if (!kind) return reply
  return { ...reply, content: [...reply.content, { type: 'text', text: `challenge: ${kind}\n${LINE}` }] }
}
