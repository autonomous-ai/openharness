import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { pickSignInMethod, signInMethodFlag, withSignInProvider } from './signInMethodPicker.js'

function tty() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean; setRawMode: (raw: boolean) => void }
  input.isTTY = true
  input.setRawMode = vi.fn()
  const chunks: string[] = []
  const output = new PassThrough()
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
  const codes: Record<string, string> = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', 'ctrl-c': '\x03' }
  return {
    input, output,
    written: () => chunks.join(''),
    press: (...keys: string[]) => { for (const key of keys) (input as unknown as PassThrough).write(codes[key] ?? key) },
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('pickSignInMethod', () => {
  it('starts on Google, so Enter alone is still the browser', async () => {
    const io = tty()
    const picked = pickSignInMethod(io)
    await tick()
    expect(io.written()).toContain('❯ Google in your browser')
    expect(io.written()).toContain('  Apple in your browser')
    expect(io.written()).not.toContain('SSO')
    io.press('enter')
    expect(await picked).toBe('google')
    expect(io.input.setRawMode).toHaveBeenLastCalledWith(false)
  })

  it('moves with the arrows (and j/k), wrapping, and takes Enter', async () => {
    const io = tty()
    const picked = pickSignInMethod(io)
    await tick()
    io.press('down')
    await tick()
    expect(io.written().split('❯ ').at(-1)).toMatch(/^Apple in your browser/)
    io.press('j', 'k', 'up', 'up', 'enter') // apple→qr→apple→google→qr
    expect(await picked).toBe('qr')
  })

  it('a row\'s number takes it at once', async () => {
    for (const [key, method] of [['1', 'google'], ['2', 'apple'], ['3', 'qr']] as const) {
      const io = tty()
      const picked = pickSignInMethod(io)
      await tick()
      io.press(key)
      expect(await picked).toBe(method)
    }
  })

  it('Esc and Ctrl-C leave with nothing chosen', async () => {
    for (const key of ['esc', 'ctrl-c']) {
      const io = tty()
      const picked = pickSignInMethod(io)
      await tick()
      io.press(key)
      expect(await picked).toBeNull()
    }
  })
})

describe('signInMethodFlag', () => {
  it('reads the method a flag names', () => {
    expect(signInMethodFlag(['--force', '--google'])).toBe('google')
    expect(signInMethodFlag(['--apple', '--json'])).toBe('apple')
    expect(signInMethodFlag(['--qr'])).toBe('qr')
  })

  it('names nothing without one — `--sso` included, which is no longer a method', () => {
    expect(signInMethodFlag(['--force', '--json'])).toBeUndefined()
    expect(signInMethodFlag(['--sso'])).toBeUndefined()
  })
})

describe('withSignInProvider', () => {
  const page = 'https://auth.example.test/oauth2/authorize?client_id=harness-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A57969%2Fcallback&state=s1&entry_point=cli'

  it('adds the account to a page from a backend that did not', () => {
    const url = new URL(withSignInProvider(page, 'google'))
    expect(url.searchParams.get('provider')).toBe('google')
    // Nothing the backend holds for the exchange is touched.
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:57969/callback')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('client_id')).toBe('harness-cli')
  })

  it('is the same page when the backend already named it, and when no account was chosen', () => {
    expect(new URL(withSignInProvider(`${page}&provider=apple`, 'apple')).searchParams.getAll('provider')).toEqual(['apple'])
    expect(withSignInProvider(page, undefined)).toBe(page)
    expect(withSignInProvider('not a url', 'google')).toBe('not a url')
  })
})
