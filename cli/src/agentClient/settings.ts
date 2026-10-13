/**
 * `harness settings`: what the person lets agents do on this computer (lib/agentSettings.ts), the same switches as
 * Settings ▸ Agents, for a terminal or a machine with no window.
 *
 *     harness settings                          every setting and its state
 *     harness settings agents-start-agents off  turn one on or off
 */
import { AGENT_SETTING_NAMES, readAgentSettings, writeAgentSettings, type AgentSettings } from '../lib/agentSettings.js'

export const SETTINGS_USAGE = `Usage: harness settings [<name> on|off]

What agents may do on this computer, as Settings ▸ Agents shows it:
  agents-start-agents   agents may start, wait for and close harnesses of their own, and are told how (on by default)`

const ABOUT: Record<keyof AgentSettings, string> = {
  agentsStartAgents: 'agents may start, wait for and close harnesses of their own',
}

export function settingsCommand(argv: readonly string[], dataDir: string, out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  if (argv.includes('--help') || argv.includes('-h')) { out(SETTINGS_USAGE); return 0 }
  const show = (settings: AgentSettings) => Object.entries(AGENT_SETTING_NAMES)
    .map(([name, key]) => `${name.padEnd(22)}${settings[key] ? 'on ' : 'off'}  ${ABOUT[key]}`).join('\n')
  if (!argv.length) { out(show(readAgentSettings(dataDir))); return 0 }
  const [name, value, ...rest] = argv
  const key = AGENT_SETTING_NAMES[name]
  if (!key || (value !== 'on' && value !== 'off') || rest.length) { err(SETTINGS_USAGE); return 2 }
  const next = writeAgentSettings(dataDir, { [key]: value === 'on' })!
  out(`${name} is ${next[key] ? 'on' : 'off'}.`)
  return 0
}
