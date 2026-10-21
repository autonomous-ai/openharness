/**
 * An agent's question reaches the owner's phone away from the desk (core/questions.ts `sendRemote`), on the
 * real daemon signed in on the fake backend, with the phone paired and reaching it through the fake relay
 * (harness/relayPhone.ts) and no window on the computer. The question crosses the relay sealed, as a recap
 * does (lib/e2ee/manager.ts `SEALED_FOR_WEB`); the phone's answer is the one the agent gets, and the close
 * that follows reaches the phone too. A phone that connects while a question is open is told it again, and
 * then which questions are open at all, so one that was here before lets go of what was answered meanwhile.
 *
 * Nothing here reaches beyond this machine: the daemon's every server setting is the fake backend's.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone, type PhoneFrame } from './harness/relayPhone.js'

const QUESTION = 'Which drink would you like?'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)

describe('an agent asks a question, and the phone away from the desk hears it', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  afterEach(async () => {
    phone?.close()
    await world?.close()
    world = undefined; phone = undefined
  })

  it('sealed over the relay with no window here; the phone\'s answer is the one the agent gets, and the close follows', async () => {
    const w = await startPhoneMachine()
    world = w
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- fake backend saw\n${backend.seen.slice(-40).join('\n')}`)
    })
    // A window makes the agent, then goes: from here only the phone can answer, which is what has the daemon
    // watch the pane for a question at all (core/main.ts `someoneCanAnswer`).
    const desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'ask-phone')
    mkdirSync(cwd, { recursive: true })
    const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const agent = await until('the agent to bind its conversation', async () => {
      const found = await row(desk, agentId)
      return found?.sessionId ? found : null
    }, 45_000, 500)
    desk.close()

    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    await phone.open(30_000)
    const isQuestion = (frame: PhoneFrame) => frame.type === 'commander_question' && frame.agentId === agentId
    const asked = phone.next(isQuestion, 45_000, 'commander_question')
    expect(phone.send('message', { agentId, content: '!ask' })).toBe(true)
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    expect(shaped?.q).toBe(QUESTION)
    expect(shaped?.options).toEqual(expect.arrayContaining(['Tea', 'Coffee']))
    const requestId: string = question.payload?.requestId
    expect(question.payload?.notification).toEqual({ id: requestId, kind: 'needsYou' })

    // On the wire the relay carried ciphertext: the question and its options are nowhere in it.
    const relayed = backend.webReceived.get(phone.connId!) ?? []
    const wire = relayed.find((frame) => frame.type === 'commander_question' && frame.agentId === agentId)
    expect(wire?.payload).toHaveProperty('__e2e')
    expect(JSON.stringify(relayed)).not.toContain(QUESTION)

    // A phone connecting while it is open is told it again, the same request, then which are open at all.
    const sessionBefore = phone.frames.length
    await phone.open(30_000)
    const again = await phone.waitFor(isQuestion, 30_000, 'the question again', sessionBefore)
    expect(again.payload?.requestId).toBe(requestId)
    const open = await phone.waitFor((frame) => frame.type === 'commander_questions_open', 30_000, 'commander_questions_open', sessionBefore)
    expect(open.payload?.requestIds).toEqual([requestId])

    // The phone answers; the agent gets that answer, and the phone hears the question close.
    // An answer goes back under the question's own request id (not a request's of its own), as in questions.e2e.ts.
    const closed = phone.next((frame) => frame.type === 'commander_question_close' && frame.agentId === agentId, 45_000, 'commander_question_close')
    const answered = phone.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, 45_000, 'question_response_result')
    expect(phone.send('question_response', { requestId, agentId, answers: { [QUESTION]: 'Coffee' } })).toBe(true)
    const result = (await answered).payload ?? {}
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect((await closed).payload?.requestId).toBe(requestId)
    await until('the agent to get the answer', async () => (await machine.daemon.capture(agent.tmuxPane)).includes('you chose Coffee') || null, 30_000, 500)

    // Asked of nobody now: a phone connecting is told no question is open.
    const sessionAfter = phone.frames.length
    await phone.open(30_000)
    const none = await phone.waitFor((frame) => frame.type === 'commander_questions_open', 30_000, 'commander_questions_open', sessionAfter)
    expect(none.payload?.requestIds).toEqual([])
    expect(phone.frames.slice(sessionAfter).some(isQuestion)).toBe(false)
  })
})
