import { describe, expect, it, vi } from 'vitest'
import { submissionFor } from '../../engines/submissions.js'
import { submissionPolicy } from '../../engines/submissionPolicies.js'
import type { PromptSpan, SubmissionReading } from '../../engines/facets/submission.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSubmissions } from './submissions.js'

const capture = '────────────\n❯ hello\n────────────\n? for shortcuts'
const row = () => ({ agentId: 'agent', sessionId: 'session', engine: 'claude', active: true,
  runtimes: [], processIdentity: { pid: 10, startMarker: 'one' } }) as unknown as RegisteredSession
function setup() {
  let current: RegisteredSession | undefined = row()
  const claude = submissionFor('claude')!
  const reading = claude.read(capture, 'hello'), span = { start: 0, end: 5 }
  const transport = { read: vi.fn(async (): Promise<SubmissionReading> => reading), echo: vi.fn(async (): Promise<PromptSpan> => span) }
  const inline = vi.fn(() => claude), handles = vi.fn(() => true)
  return { submissions: createSubmissions({ policy: submissionPolicy, resolve: () => current, transport, inline, handles }),
    transport, inline, handles, reading, span, row: current, replace: (next?: RegisteredSession) => { current = next } }
}

describe('core submission evidence', () => {
  it('asks the bound worker, or the inline reader only in explicit inline mode, and keeps nothing', async () => {
    const t = setup()
    expect(t.submissions.policy('claude')).toEqual(submissionFor('claude')!.policy)
    expect(t.submissions.policy('cursor')).toBeUndefined()
    expect(await t.submissions.read(t.row, capture, 'hello')).toEqual(t.reading)
    expect(await t.submissions.echo(t.row, 'hello')).toEqual(t.span)
    expect(t.transport.read).toHaveBeenCalledWith('claude', capture, 'hello')
    expect(t.transport.echo).toHaveBeenCalledWith('claude', 'hello')
    expect(t.inline).not.toHaveBeenCalled()
    t.handles.mockReturnValue(false)
    expect(await t.submissions.read(t.row, capture, 'hello')).toEqual({ draft: true, composer: true, nativeDraft: 'pending' })
    const recorded = '<pasted_content id="ab">\nhello\n</pasted_content id="ab">'
    expect(await t.submissions.echo(t.row, recorded)).toEqual({ start: 25, end: 30 })
    expect(t.inline).toHaveBeenCalledWith('claude')
    // An engine with no reader inline is no reading, never an empty one.
    t.inline.mockReturnValue(undefined as never)
    expect(await t.submissions.read(t.row, capture, 'hello')).toBeNull()
    expect(await t.submissions.echo(t.row, 'hello')).toBeNull()
    expect(t.transport.read).toHaveBeenCalledOnce()
  })

  it('refuses text past the bounds, and a session that is not the one bound, before asking anyone', async () => {
    const t = setup()
    expect(await t.submissions.read(t.row, 'é'.repeat(256 * 1024), 'hello')).toBeNull()
    expect(await t.submissions.read(t.row, capture, 'x'.repeat(1024 * 1024 + 1))).toBeNull()
    expect(await t.submissions.echo(t.row, 'é'.repeat(512 * 1024 + 1))).toBeNull()
    expect(await t.submissions.read({ ...t.row, agentId: '' }, capture, 'hello')).toBeNull()
    expect(await t.submissions.echo({ ...t.row, sessionId: 'old' }, 'hello')).toBeNull()
    t.replace()
    expect(await t.submissions.read(t.row, capture, 'hello')).toBeNull()
    expect(t.transport.read).not.toHaveBeenCalled()
    expect(t.transport.echo).not.toHaveBeenCalled()
  })

  it('takes a failed worker as no reading, and never reads inline instead', async () => {
    const t = setup()
    t.transport.read.mockRejectedValue(new Error('worker stopped'))
    t.transport.echo.mockRejectedValue(new Error('worker stopped'))
    expect(await t.submissions.read(t.row, capture, 'hello')).toBeNull()
    expect(await t.submissions.echo(t.row, 'hello')).toBeNull()
    expect(t.inline).not.toHaveBeenCalled()
  })

  it.each(['sessionId', 'engine', 'active', 'processIdentity', 'runtimes'] as const)('discards a reading after an in-place %s change', async field => {
    const t = setup()
    let finish!: (value: SubmissionReading) => void
    t.transport.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const read = t.submissions.read(t.row, capture, 'hello')
    Object.assign(t.row, { [field]: field === 'active' ? false : field === 'processIdentity' ? { pid: 20 } : field === 'runtimes' ? [{ paneId: 'new' }] : 'changed' })
    finish(t.reading)
    expect(await read).toBeNull()
  })
})
