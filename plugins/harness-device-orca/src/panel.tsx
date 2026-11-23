// The panel: the dial's state as the worker tells it. No build step: Orca strips the types and compiles the JSX.
import { atom, Button, plugin, read, set, shell, Stack, Text, type PanelContext } from 'orca'
import type { DialState } from './protocol'

const GET_HARNESS = 'https://harness.autonomous.ai/desktop'

const LINES: Record<Exclude<DialState['state'], 'checking'>, string> = {
  noHarness: "Harness isn't installed.",
  notRunning: "Harness isn't running.",
  elsewhere: 'Open in another Orca.',
  unplugged: 'Dial unplugged.',
  attached: 'Dial attached.',
}

const dial = atom<DialState>({ state: 'checking' })

export function setup(ctx: PanelContext): void {
  let told = false
  ctx.subscriptions.push(
    plugin.on('dial.changed', (state) => {
      told = true
      set(dial, state)
    })
  )
  // A change told while dial.get was on its way is newer than its answer. A refused dial.get leaves the panel as it
  // is until the next change.
  plugin.request('dial.get').then(
    (state) => {
      if (!told) set(dial, state)
    },
    () => {}
  )
}

export default function Panel() {
  const { state, agent } = read(dial)
  if (state === 'checking') return null
  // A name and an app are outside text: plain Text children, never Markdown.
  if (agent)
    return (
      <Stack gap="xs">
        <Text>{agent.name}</Text>
        <Text muted>{agent.app}</Text>
      </Stack>
    )
  return (
    <Stack gap="md">
      <Text>{LINES[state]}</Text>
      {/* A link Orca refuses to open leaves the button as it was, for another press. */}
      {state === 'noHarness' && <Button onPress={() => shell.openExternal(GET_HARNESS).catch(() => {})}>Get Harness</Button>}
    </Stack>
  )
}
