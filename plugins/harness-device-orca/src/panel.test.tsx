// The panel drawn by Orca's test kit, over a mock host that answers `dial.get` in the worker's place.
import { assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { PanelContext } from 'orca'
import type { DialState } from './protocol'

const GET_HARNESS = 'https://harness.autonomous.ai/desktop'

const LINES: [DialState, string][] = [
  [{ state: 'windows' }, 'Not on Windows yet.'],
  [{ state: 'noHarness' }, "Harness isn't installed."],
  [{ state: 'notRunning' }, "Harness isn't running."],
  [{ state: 'elsewhere' }, 'Open in another Orca.'],
  [{ state: 'unplugged' }, 'Dial unplugged.'],
  [{ state: 'attached' }, 'Dial attached.'],
]

async function drawn(state: DialState): Promise<TestPanel> {
  const view = await mount(panel, { host: mockHost({ requests: { 'dial.get': () => state } }) })
  await view.settled()
  return view
}

async function clean(view: TestPanel): Promise<void> {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
}

test('checking draws nothing', async () => {
  const view = await drawn({ state: 'checking' })
  assert.deepEqual(view.findAll({ text: /\S/ }), [])
  assert.deepEqual(view.findAll({ role: 'button' }), [])
  await clean(view)
})

test('each state draws its line', async () => {
  for (const [state, line] of LINES) {
    const view = await drawn(state)
    assert.ok(view.find({ text: line }), `${state.state} draws "${line}"`)
    await clean(view)
  }
})

test('an agent is its name, and its app on a second line', async () => {
  const view = await drawn({ state: 'attached', agent: { name: 'api', app: 'Orca' } })
  assert.ok(view.find({ text: 'api' }))
  assert.equal(view.find({ text: 'Orca' })?.props.muted, true)
  assert.equal(view.find({ text: 'Dial attached.' }), null)
  await clean(view)
})

test('Get Harness opens https://harness.autonomous.ai/desktop', async () => {
  const view = await drawn({ state: 'noHarness' })
  await view.press({ text: 'Get Harness' })
  assert.deepEqual(view.host.callsOf('shell.openExternal'), [{ url: GET_HARNESS }])
  await clean(view)
})

test('only noHarness has a button', async () => {
  const states: DialState[] = [
    { state: 'checking' },
    ...LINES.map(([state]) => state),
    { state: 'attached', agent: { name: 'api', app: 'Orca' } },
  ]
  for (const state of states) {
    const view = await drawn(state)
    const buttons = view.findAll({ role: 'button' }).length
    assert.equal(buttons, state.state === 'noHarness' ? 1 : 0, state.state)
    await clean(view)
  }
})

test('the panel follows dial.changed with no refresh', async () => {
  const view = await drawn({ state: 'checking' })
  await view.post('dial.changed', { state: 'unplugged' })
  assert.ok(view.find({ text: 'Dial unplugged.' }))
  await view.post('dial.changed', { state: 'attached' })
  assert.ok(view.find({ text: 'Dial attached.' }))
  await view.post('dial.changed', { state: 'attached', agent: { name: 'api', app: 'Orca' } })
  assert.ok(view.find({ text: 'api' }))
  await view.post('dial.changed', { state: 'unplugged' })
  assert.ok(view.find({ text: 'Dial unplugged.' }))
  assert.equal(view.find({ text: 'api' }), null)
  await clean(view)
})

test('a dial.get answered after a dial.changed is not drawn over it', async () => {
  // The kit's mount waits for each call the panel makes, so the late dial.get is a second setup's, once it has drawn.
  let ctx: PanelContext | null = null
  const answers: (DialState | Promise<DialState>)[] = [{ state: 'checking' }]
  let answer: (state: DialState) => void = () => {}
  answers.push(new Promise<DialState>((done) => (answer = done)))
  const host = mockHost({ requests: { 'dial.get': () => answers.shift()! } })
  const view = await mount(
    {
      default: panel.default,
      setup(given) {
        ctx = given
        panel.setup(given)
      },
    },
    { host }
  )
  panel.setup(ctx!)
  // A post reaches the panel at once; it settles once the late dial.get is answered.
  const posted = view.post('dial.changed', { state: 'attached' })
  answer({ state: 'unplugged' })
  await posted
  assert.ok(view.find({ text: 'Dial attached.' }))
  await clean(view)
})

test('a dial.get the worker refuses draws nothing and throws nothing; the next dial.changed is drawn', async () => {
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'dial.get': () => {
          throw hostError('unavailable')
        },
      },
    }),
  })
  await view.settled()
  assert.deepEqual(view.findAll({ text: /\S/ }), [])
  await view.post('dial.changed', { state: 'unplugged' })
  assert.ok(view.find({ text: 'Dial unplugged.' }))
  await clean(view)
})

test('a name is drawn as it is', async () => {
  const name = '**bold** [x](http://e) <b>'
  const view = await drawn({ state: 'attached', agent: { name, app: 'Orca' } })
  assert.ok(view.find({ text: name }))
  await clean(view)
})
