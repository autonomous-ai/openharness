import { emitKeypressEvents } from 'node:readline'

/** The accounts a browser sign-in goes straight to (backend `SIGN_IN_PROVIDERS`). */
export type SignInProvider = 'google' | 'apple'
export type SignInMethod = SignInProvider | 'qr'

const OPTIONS: Array<{ method: SignInMethod; label: string }> = [
  { method: 'google', label: 'Google in your browser' },
  { method: 'apple', label: 'Apple in your browser' },
  { method: 'qr', label: 'Scan a QR with Harness on your phone' },
]

/** `harness login --google|--apple|--qr`: the method a flag names, so nothing is asked. */
export const signInMethodFlag = (flags: readonly string[]): SignInMethod | undefined =>
  OPTIONS.find((option) => flags.includes(`--${option.method}`))?.method

/** How a provider is written for a person: `Google`, `Apple`. */
export const signInProviderName = (provider: SignInProvider): string =>
  provider === 'google' ? 'Google' : 'Apple'

/**
 * The sign-in page's address, opening on [provider]'s own sign-in.
 *
 * The backend writes `provider` into the page it hands back — but only one that knows the field
 * does, and this CLI reaches people before the backend it talks to is redeployed. The parameter is
 * the browser's to carry and changes nothing the backend holds (state, PKCE, client), so it is
 * set here as well: the same value where the backend already wrote it, the missing one where not.
 */
export function withSignInProvider(authorizeUrl: string, provider: SignInProvider | undefined): string {
  if (!provider) return authorizeUrl
  let url: URL
  try { url = new URL(authorizeUrl) } catch { return authorizeUrl }
  url.searchParams.set('provider', provider)
  return url.toString()
}

/**
 * `harness login` at a terminal with no flag: how to sign in. ↑/↓ (or k/j) move, Enter takes,
 * a row's number takes it at once, Esc / q / Ctrl-C leave with null. Starts on Google, the first
 * of the two accounts. Drawn in place like `harness remote`'s machine picker — the rows are
 * rewritten on every move.
 */
export function pickSignInMethod(io: {
  input: NodeJS.ReadStream & { isTTY?: boolean }
  output: NodeJS.WritableStream
}): Promise<SignInMethod | null> {
  const { input, output } = io
  return new Promise((resolve) => {
    let index = 0
    let drawn = 0
    const draw = (): void => {
      if (drawn) output.write(`\x1b[${drawn}A\x1b[J`)
      const lines = [
        '  Sign in with:   ↑/↓ choose · Enter select · Esc cancel',
        ...OPTIONS.map((o, at) => `  ${at === index ? '❯' : ' '} ${o.label}`),
      ]
      output.write(lines.join('\n') + '\n')
      drawn = lines.length
    }
    const finish = (method: SignInMethod | null): void => {
      input.off('keypress', onKey)
      if (input.isTTY) input.setRawMode(false)
      input.pause()
      resolve(method)
    }
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } = {}): void => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') { finish(null); return }
      if (key.name === 'return' || key.name === 'enter') { finish(OPTIONS[index]!.method); return }
      const n = Number(text)
      if (Number.isInteger(n) && n >= 1 && n <= OPTIONS.length) { index = n - 1; draw(); finish(OPTIONS[index]!.method); return }
      if (key.name === 'up' || key.name === 'k') index = (index - 1 + OPTIONS.length) % OPTIONS.length
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % OPTIONS.length
      else return
      draw()
    }
    emitKeypressEvents(input)
    if (input.isTTY) input.setRawMode(true)
    input.resume()
    input.on('keypress', onKey)
    output.write('\n')
    draw()
  })
}
