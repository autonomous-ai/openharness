import { expect, it } from 'vitest'

const { listeningPort } = await import('../../e2e/harness/daemon.js' as string) as { listeningPort: (output: string) => number | null }
const said = (port: number) => `[hooks] listening on 127.0.0.1:${port} (SessionStart/SessionEnd callbacks)\n`

it('reads the port the daemon said it listens on', () => {
  expect(listeningPort(`[hooks] control port 34881 unavailable; assigning a separate port for this user\n${said(42457)}`)).toBe(42457)
})
it('follows the last line: a core started again on another port', () => {
  expect(listeningPort(`${said(42457)}[harnessd] core started (pid 2)\n${said(42999)}`)).toBe(42999)
})
it('has no port before the daemon said one: the socket\'s line and the core\'s summary are other lines', () => {
  expect(listeningPort('')).toBeNull()
  expect(listeningPort('[hooks] listening on /tmp/h/data/daemon-34881.sock\n[cli] daemon pid 7 · v0.6.12 · listening on 127.0.0.1:34881\n')).toBeNull()
})
it('does not read a line caught in the middle of its port', () => {
  expect(listeningPort('[hooks] listening on 127.0.0.1:424')).toBeNull()
  expect(listeningPort(`${said(42457)}[hooks] listening on 127.0.0.1:429`)).toBe(42457)
})
