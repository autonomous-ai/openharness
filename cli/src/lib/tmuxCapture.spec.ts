import { describe, expect, it, vi } from 'vitest'
import { captureTmuxPane, TmuxCaptureBatcher, tmuxCaptureArgs } from './tmuxCapture.js'

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

type Execute = NonNullable<ConstructorParameters<typeof TmuxCaptureBatcher>[0]>

function commands(args: string[]): string[][] {
  const result: string[][] = [[]]
  for (const arg of args) {
    if (arg === ';') result.push([])
    else result[result.length - 1].push(arg)
  }
  return result
}

function server(panes: Record<string, string>) {
  const run: Execute = (args, _options, done) => {
    let stdout = ''
    for (const command of commands(args)) {
      if (command[0] === 'display-message') stdout += `${command[2]}\n`
      else {
        const pane = command[command.indexOf('-t') + 1]
        if (!(pane in panes)) { done(new Error('missing pane'), stdout); return }
        stdout += panes[pane]
      }
    }
    done(null, stdout)
  }
  const execute = vi.fn(run)
  return { panes, execute, capture: new TmuxCaptureBatcher(execute) }
}

describe('fresh tmux capture batching', () => {
  it('the public capture helper uses the default tmux process executor', async () => {
    childProcess.execFile.mockImplementation((_file, _args, _options, done) => done(null, 'default screen\n'))
    expect(await captureTmuxPane('%7', 40, { ansi: false })).toBe('default screen\n')
    expect(childProcess.execFile).toHaveBeenCalledOnce()
    // Its 2 s deadline is patientExec's own, which a held event loop cannot fool, not Node's `timeout`.
    expect(childProcess.execFile.mock.calls[0].slice(0, 3)).toEqual([
      'tmux', tmuxCaptureArgs('%7', 40, { ansi: false }), { maxBuffer: 1024 * 1024, encoding: 'utf8' },
    ])
  })

  it('reads concurrent panes in one process without mixing ANSI, empty, or multiline captures', async () => {
    const h = server({ '%1': '\u001b[31mhello\u001b[0m\nnext\n', '%2': '\n', '%3': 'third\n\n' })
    expect(await Promise.all(['%1', '%2', '%3'].map(id => h.capture.capture(id)))).toEqual(Object.values(h.panes))
    expect(h.execute).toHaveBeenCalledOnce()
    expect(h.execute.mock.calls[0][1]).toEqual({ timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
  })

  it('keeps solitary and subsequent captures fresh, with no framing or terminal cache', async () => {
    const h = server({ '%1': 'before\n' })
    expect(await h.capture.capture('%1', 60, { ansi: false, visible: true })).toBe('before\n')
    expect(h.execute.mock.calls[0][0]).toEqual(['capture-pane', '-p', '-J', '-t', '%1'])
    expect(h.execute.mock.calls[0][1]).toEqual({ timeout: 2_000, maxBuffer: 1024 * 1024 })
    h.panes['%1'] = 'after\n'
    expect(await h.capture.capture('%1')).toBe('after\n')
    expect(h.execute).toHaveBeenCalledTimes(2)
  })

  it('a completely empty framed capture stays distinct from an unavailable pane', async () => {
    const h = server({ '%1': '', '%2': 'visible\n' })
    expect(await Promise.all([h.capture.capture('%1'), h.capture.capture('%2')])).toEqual(['', 'visible\n'])
    expect(h.execute).toHaveBeenCalledOnce()
  })

  it('preserves each requested ANSI, visible-screen, and history option', async () => {
    const h = server({ '%1': 'one\n', '%2': 'two\n' })
    await Promise.all([h.capture.capture('%1', 60), h.capture.capture('%2', 300, { ansi: false, visible: true })])
    expect(commands(h.execute.mock.calls[0][0]).filter(command => command[0] === 'capture-pane')).toEqual([
      tmuxCaptureArgs('%1', 60), tmuxCaptureArgs('%2', 300, { ansi: false, visible: true }),
    ])
  })

  it.each([0, 1, 2])('one missing pane at position %i cannot hide another pane or return a partial frame', async missing => {
    const h = server({ '%0': 'zero\n', '%1': 'one\n', '%2': 'two\n' })
    delete h.panes[`%${missing}`]
    expect(await Promise.all(['%0', '%1', '%2'].map(id => h.capture.capture(id))))
      .toEqual([h.panes['%0'] ?? null, h.panes['%1'] ?? null, h.panes['%2'] ?? null])
    // The successfully framed prefix is not read twice. The failed pane and
    // the commands tmux never reached get independent reads.
    expect(h.execute).toHaveBeenCalledTimes(1 + 3 - missing)
  })

  it('retries a truncated batch frame instead of interpreting it as a complete screen', async () => {
    const h = server({ '%1': 'whole first screen\n', '%2': 'whole second screen\n' })
    h.execute.mockImplementationOnce((args, _options, done) => {
      const start = commands(args)[0][2]
      done(new Error('maxBuffer exceeded'), `${start}\npartial screen\n`)
    })
    expect(await Promise.all([h.capture.capture('%1'), h.capture.capture('%2')]))
      .toEqual(['whole first screen\n', 'whole second screen\n'])
    expect(h.execute).toHaveBeenCalledTimes(3)
  })

  it('does not accept an end-marker fragment inside a terminal line', async () => {
    const h = server({ '%1': 'full first\n', '%2': 'full second\n' })
    h.execute.mockImplementationOnce((args, _options, done) => {
      const batch = commands(args)
      done(new Error('truncated'), `${batch[0][2]}\npartial${batch[2][2]}\n`)
    })
    expect(await Promise.all([h.capture.capture('%1'), h.capture.capture('%2')])).toEqual(['full first\n', 'full second\n'])
  })

  it('bounds both command batches and output per pane', async () => {
    const panes = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`%${i}`, `pane-${i}\n`]))
    const h = server(panes)
    expect(await Promise.all(Object.keys(panes).map(id => h.capture.capture(id)))).toEqual(Object.values(panes))
    expect(h.execute).toHaveBeenCalledTimes(3)
    expect(h.execute.mock.calls.map(([args]) => commands(args).filter(command => command[0] === 'capture-pane').length))
      .toEqual([32, 32, 1])
    h.panes['%0'] = `${'界'.repeat(350_000)}\n`
    expect(await Promise.all([h.capture.capture('%0'), h.capture.capture('%1')])).toEqual([null, 'pane-1\n'])
  })

  it('rejects malformed targets before constructing a compound command', async () => {
    const h = server({ '%1': 'safe\n' })
    for (const target of [';', '%1;', '%1\n', '-t', '', 'named-session', '%-2', '#{pane_id}']) {
      expect(await h.capture.capture(target)).toBeNull()
    }
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('resolves unavailable when tmux cannot be spawned, including the fallback', async () => {
    const execute = vi.fn<Execute>(() => { throw new Error('spawn failed') })
    const h = new TmuxCaptureBatcher(execute)
    expect(await Promise.all([h.capture('%1'), h.capture('%2')])).toEqual([null, null])
    expect(await h.capture('%3')).toBeNull()
  })

  it('never returns a failed single capture\'s partial stdout as a screen', async () => {
    const capture = new TmuxCaptureBatcher((_args, _options, done) => done(new Error('timed out'), 'partial question\n'))
    expect(await capture.capture('%1')).toBeNull()
  })

  it('does not deduplicate reads of a pane that may change between commands', async () => {
    let count = 0
    const h = server({ get '%1'() { return `screen ${++count}\n` } })
    expect(await Promise.all([h.capture.capture('%1'), h.capture.capture('%1')])).toEqual(['screen 1\n', 'screen 2\n'])
  })
})
