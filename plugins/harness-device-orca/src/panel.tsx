// The panel: the dial's state as the worker tells it. No build step: Orca strips the types and compiles the JSX.
import { atom, Button, plugin, read, set, shell, Stack, Text, type PanelContext } from 'orca'
import type { DialState } from './protocol'

const GET_HARNESS = 'https://harness.autonomous.ai/desktop'

const LINES: Record<Exclude<DialState['state'], 'checking'>, string> = {
  windows: 'Not on Windows yet.',
  noHarness: "Harness isn't installed.",
  notRunning: "Harness isn't running.",
  elsewhere: 'Open in another Orca.',
  unplugged: 'Dial unplugged.',
  attached: 'Dial attached.',
}

const dial = atom<DialState>({ state: 'checking' })

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('dial.changed', (state) => set(dial, state)))
  void plugin.request('dial.get').then((state) => set(dial, state))
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
      {state === 'noHarness' && <Button onPress={() => void shell.openExternal(GET_HARNESS)}>Get Harness</Button>}
    </Stack>
  )
}
