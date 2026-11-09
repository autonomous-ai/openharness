// Task #3593 (anh Dee, rules to code): the server writes the project's status card from task, step, pull request and release state,
// one line per active task, so the PM is not woken every 15 minutes to reread messages and rewrite it.
import { describe, expect, it } from 'vitest'
import { appendPullRequestUrls, visibleState } from './model.js'
import { projectOf } from './projects.js'
import { PROJECT_STATUS_MAX } from './projects.js'
import { cardText, projectCard } from './statusCard.js'
import { owner, stepsFixture } from './steps.test-support.js'
import { usernameOf } from './usernames.js'

const PR = 'https://github.com/acme/app/pull/7'

function cardFixture() {
  const f = stepsFixture()
  const chat = () => f.group('lead')
  const lines = () => projectCard(f.state, projectOf(f.state, 'lead'), f.now).lines
  const line = (id = f.task) => lines().find(l => l.id === id)
  const text = () => visibleState(f.state, owner).projects!.find(p => p.id === 'lead')!.status?.text
  const assignment = () => f.group(f.task).assignment!.id
  const work = (status: 'working' | 'review' | 'blocked' | 'needs_human' | 'done', result: string | null = null) => {
    const effects = f.run({ type: 'work.status', conversationId: f.task, assignmentId: assignment(), status, result }, f.as(f.dev))
    // As the store does after each command: the Ready line's link is the task's linked pull request.
    if (result?.includes(PR)) { appendPullRequestUrls(f.group(f.task), [PR]); f.run({ type: 'message.send', conversationId: 'lead', text: 'tick', replyTo: null, recipientIds: [] }) }
    return effects
  }
  return Object.assign(f, { chat, lines, line, text, work, assignment })
}

describe('the status card the server writes (#3593)', () => {
  it('has one line per active task with its state, what it waits on and its owner', () => {
    const f = cardFixture()
    expect(f.lines()).toHaveLength(1)
    expect(f.line()!.text).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie.')
    const second = f.run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks: [{ description: 'Saves', independent: true }],
      priority: 'P2', requesterId: 'owner' }, f.as(f.lead)).result.conversationId as string
    expect(f.lines().map(l => l.id).sort()).toEqual([f.task, second].sort())
    expect(f.line(second)!.text).toContain('to do. Waits on: an owner. Owner: none.')
  })

  it('says review with its pull request and the steps it waits on, and blocked, needs a person and lost', () => {
    const f = cardFixture()
    f.step('Review')
    f.work('review', `Ready for review: ${PR} at abc1234`)
    expect(f.line()!.text).toBe(`#1 "Fix login": in review (PR #7). Waits on: step Review. Owner: Andie.`)
    f.work('blocked', 'Needs the CI key.')
    expect(f.line()!.text).toContain('blocked. Waits on: the PM.')
    f.work('needs_human', 'Which API?')
    expect(f.line()!.text).toContain('needs a person. Waits on: a decision.')
    f.group(f.task).assignment!.status = 'lost'
    f.run({ type: 'message.send', conversationId: f.task, text: 'ping', replyTo: null, recipientIds: [] })
    expect(f.line()!.text).toContain('lost. Waits on: another engineer.')
  })

  it('says a task waits on its requester\'s approval, leaves out a rejected one, and says a paused one is paused (Swarm v3)', () => {
    const f = cardFixture()
    f.run({ type: 'member.approvalMode', mode: 'review' })
    const proposed = f.run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks: [{ description: 'Saves', independent: true }],
      priority: 'P2', requesterId: 'owner' }, f.as(f.lead)).result.conversationId as string
    expect(f.line(proposed)!.text).toBe(`#2 "Offline editing": proposed. Waits on: @${usernameOf(f.state, 'owner')}'s approval. Owner: none.`)
    f.run({ type: 'task.reject', conversationId: proposed, reason: 'Not now.' })
    expect(f.line(proposed)).toBeUndefined()
    f.run({ type: 'work.pause', conversationId: f.task, paused: true, reason: 'release freeze' })
    expect(f.line()!.text).toBe('#1 "Fix login": paused. Waits on: a person to resume it (release freeze). Owner: Andie.')
    f.run({ type: 'work.pause', conversationId: f.task, paused: false })
    expect(f.line()!.text).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie.')
  })

  it('drops a task whose work ended, a merged one too, and shows a merged one its builder has not closed', () => {
    const f = cardFixture()
    f.work('review', `Ready for review: ${PR} at abc1234`)
    f.run({ type: 'conversation.merged', conversationId: f.task, pullRequestUrl: PR }, f.as(f.lead))
    expect(f.line()!.text).toBe('#1 "Fix login": merged (PR #7). Waits on: its builder to close it. Owner: Andie.')
    f.work('done', `Merged ${PR}`)
    expect(f.line()).toBeUndefined()
  })

  it('keeps a line\'s time while it says the same, and moves it when it changes', () => {
    const f = cardFixture()
    const first = f.line()!.since
    f.tick(60_000)
    f.run({ type: 'message.send', conversationId: f.task, text: 'Halfway.', replyTo: null, recipientIds: [] }, f.as(f.dev))
    f.work('working', 'Tests written')
    expect(f.line()!.since).toBe(first)
    f.tick(60_000)
    f.work('review', `Ready for review: ${PR} at abc1234`)
    expect(f.line()!.since).toBe(first! + 120_000)
  })

  it('shows readers the lines and the PM\'s extra text, in the card\'s own text', () => {
    const f = cardFixture()
    expect(f.text()).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie. Since 00:00 UTC.')
    f.run({ type: 'project.report', projectId: 'lead', through: {}, text: 'Freeze starts Friday.' }, f.as(f.lead))
    expect(f.text()).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie. Since 00:00 UTC.\nFreeze starts Friday.')
    // A change of the lines does not lose it.
    f.work('review', `Ready for review: ${PR} at abc1234`)
    expect(f.text()).toContain('Freeze starts Friday.')
    expect(f.text()).toContain('in review (PR #7)')
    // Without text the report leaves the extra lines as they are.
    f.run({ type: 'project.report', projectId: 'lead', through: {}, text: null }, f.as(f.lead))
    expect(f.text()).toContain('Freeze starts Friday.')
  })

  it('does not show a card saved before the server wrote it beside the server\'s lines', () => {
    const f = cardFixture()
    // The coordinator's whole card of an earlier release: stored with no mark that it is its own lines.
    projectOf(f.state, 'lead').status = { text: 'Old whole card: #1 Fix login working.', at: new Date(0).toISOString(), by: f.lead }
    f.run({ type: 'message.send', conversationId: 'lead', text: 'tick', replyTo: null, recipientIds: [] })
    expect(f.text()).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie. Since 00:00 UTC.')
    // Its next report is its own lines.
    f.run({ type: 'project.report', projectId: 'lead', through: {}, text: 'Freeze starts Friday.' }, f.as(f.lead))
    expect(f.text()!.endsWith('\nFreeze starts Friday.')).toBe(true)
    expect(f.text()).not.toContain('Old whole card')
  })

  it('shows the same card when a read applies the reader\'s view twice', () => {
    const f = cardFixture()
    f.run({ type: 'project.report', projectId: 'lead', through: {}, text: 'Freeze starts Friday.' }, f.as(f.lead))
    const once = visibleState(f.state, owner)
    const twice = visibleState(once, owner)
    expect(twice.projects!.find(p => p.id === 'lead')!.status!.text).toBe(once.projects!.find(p => p.id === 'lead')!.status!.text)
    expect(twice.projects!.find(p => p.id === 'lead')!.status!.text).toContain('Freeze starts Friday.')
  })

  // Task #4419: the card on the project chat made every task-changing command write the chat, so the next one read it whole,
  // 6-7 KB over #4368's budgets. Each task keeps its own line; a command writes only the lines that changed.
  it('keeps each task\'s line on the task, writes only a changed one, and never a card on the project chat', () => {
    const f = cardFixture()
    const second = f.run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits.', checks: [{ description: 'Saves', independent: true }],
      priority: 'P2', requesterId: 'owner' }, f.as(f.lead)).result.conversationId as string
    expect(f.group(f.task).statusLine).toEqual({ text: '#1 "Fix login": working. Waits on: nothing. Owner: Andie.', since: expect.any(Number) })
    const kept = f.group(second).statusLine
    f.work('review', `Ready for review: ${PR} at abc1234`)
    expect(f.group(f.task).statusLine!.text).toContain('in review (PR #7)')
    expect(f.group(second).statusLine).toEqual(kept)
    expect(f.chat()).not.toHaveProperty('card')
  })

  // Tasks stored before #4419 keep no line: the first command after the release must not write every one of them (prod's busiest
  // project has ~180 open, one transaction), so a line is written only by a command that moves it, and the card builds the rest.
  it('writes no line for a task stored without one that a command does not move, and still shows it on the card', () => {
    const f = cardFixture()
    delete f.group(f.task).statusLine
    f.run({ type: 'message.send', conversationId: 'lead', text: 'tick', replyTo: null, recipientIds: [] })
    expect(f.group(f.task).statusLine).toBeUndefined()
    expect(f.text()).toBe('#1 "Fix login": working. Waits on: nothing. Owner: Andie.')
    // The command that moves it writes it.
    f.work('review', `Ready for review: ${PR} at abc1234`)
    expect(f.group(f.task).statusLine).toEqual({ text: '#1 "Fix login": in review (PR #7). Waits on: a review. Owner: Andie.', since: expect.any(Number) })
  })

  it('leaves an ended task\'s line empty, dated, so a reader learns the card dropped it', () => {
    const f = cardFixture()
    f.tick(60_000)
    f.work('done', 'Shipped without a pull request.')
    expect(f.line()).toBeUndefined()
    expect(f.group(f.task).statusLine).toEqual({ text: '', since: expect.any(Number) })
  })

  it('keeps the card within its limit, naming how many tasks the last line leaves out', () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, text: `#${i} "A task with a title that takes room": working. Waits on: nothing. Owner: Andie.`, since: 0 }))
    const text = cardText(lines, 'Extra line.')
    expect(text.length).toBeLessThanOrEqual(PROJECT_STATUS_MAX)
    expect(text).toContain('Extra line.')
    expect(text).toMatch(/\n\d+ more tasks\./)
  })

  it('reaches only those who read the project chat', () => {
    const f = cardFixture()
    const withoutChat = { ...f.state, conversations: f.state.conversations.filter(c => c.id !== 'lead') }
    expect(visibleState(withoutChat, owner).projects?.find(p => p.id === 'lead')).not.toHaveProperty('status')
  })
})
