/**
 * `harness browser <command>`'s arguments and help. Each command is one tool of browser-tools.json, named without
 * `browser_`, and builds that tool's arguments as its `inputSchema` names them. The help is the JSON's examples, so it
 * cannot name a command or an argument the tool does not take, and it needs no daemon and no browser.
 */
import { browserTools } from '../lib/browserToolsAsset.js'

export type BrowserCall = { command: string; args: Record<string, unknown>; stdin?: 'text' }

/** The agent asked to start or stop its browser: only its person does that, from the Browser button in its chat. */
export const START_STOP_USAGE = 'Only your person starts and stops your browser: Browser in your chat.'

const ANY_USAGE = 'Usage: harness browser <command>. The commands: harness browser --help'

/** A command's words: before `--`, `--name` is a flag; after it every word is text, so text may look like a flag. */
type Words = { words: string[]; flags: Record<string, string | true>; textFrom: number }
type Form = {
  usage: string
  flags?: Record<string, 'switch' | 'value'>
  call: (words: Words) => Omit<BrowserCall, 'command'> | undefined
}

const none = ({ words }: Words) => words.length === 0 ? { args: {} } : undefined
const one = (key: string) => ({ words }: Words) => words.length === 1 ? { args: { [key]: words[0] } } : undefined
const number = (word: string): number | undefined => /^-?\d+(\.\d+)?$/.test(word) ? Number(word) : undefined
const count = (word: string | undefined): number | undefined => word !== undefined && /^\d+$/.test(word) ? Number(word) : undefined

function tabs([action = 'list', index, ...rest]: string[]): Omit<BrowserCall, 'command'> | undefined {
  if (rest.length > 0) return undefined
  if (action === 'list' || action === 'new') return index === undefined ? { args: { action } } : undefined
  if (action === 'close' && index === undefined) return { args: { action } }
  const n = count(index)
  return (action === 'select' || action === 'close') && n !== undefined ? { args: { action, index: n } } : undefined
}

const FORMS: Record<string, Form> = {
  navigate: { usage: 'navigate <url>', call: one('url') },
  back: { usage: 'back', call: none },
  snapshot: { usage: 'snapshot', call: none },
  click: { usage: 'click <ref>', call: one('ref') },
  type: {
    usage: 'type <ref> <text> [--submit]',
    flags: { '--submit': 'switch' },
    call: ({ words: [ref, text, ...rest], flags, textFrom }) => {
      if (text === undefined || rest.length > 0) return undefined
      const submit = flags['--submit'] ? { submit: true } : {}
      // `-` before `--` reads the text from standard input, so quotes and new lines need no shell escaping.
      return text === '-' && textFrom > 1
        ? { args: { ref, ...submit }, stdin: 'text' }
        : { args: { ref, text, ...submit } }
    },
  },
  press: { usage: 'press <key>', call: one('key') },
  select: {
    usage: 'select <ref> <value>…',
    call: ({ words: [ref, ...values] }) => values.length > 0 ? { args: { ref, values } } : undefined,
  },
  scroll: {
    usage: 'scroll <dy>',
    call: ({ words }) => {
      const dy = words.length === 1 ? number(words[0]) : undefined
      return dy === undefined ? undefined : { args: { dy } }
    },
  },
  screenshot: { usage: 'screenshot', call: none },
  tabs: { usage: 'tabs [list | new | select <n> | close [<n>]]', call: ({ words }) => tabs(words) },
  wait: {
    usage: 'wait <text> | wait --ms <n>',
    flags: { '--ms': 'value' },
    call: ({ words, flags }) => {
      if (flags['--ms'] === undefined) return words.length === 1 ? { args: { text: words[0] } } : undefined
      const ms = count(flags['--ms'] as string)
      return words.length === 0 && ms !== undefined ? { args: { ms } } : undefined
    },
  },
}

/** Splits a command's arguments into words and the flags its form takes; undefined for a flag it does not take. */
function split(argv: readonly string[], known: Form['flags'] = {}): Words | undefined {
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--') return { words: [...words, ...argv.slice(i + 1)], flags, textFrom: words.length }
    if (!word.startsWith('--')) { words.push(word); continue }
    const kind = Object.hasOwn(known, word) ? known[word] : undefined
    if (!kind || word in flags) return undefined
    if (kind === 'switch') flags[word] = true
    else if (i + 1 < argv.length) flags[word] = argv[++i]
    else return undefined
  }
  return { words, flags, textFrom: words.length }
}

/** `argv` is what follows `harness browser`. `usage` is one line; `help` asks for the help. */
export function parseBrowserArgs(argv: readonly string[]): BrowserCall | { usage: string } | { help: true } {
  const [command, ...rest] = argv
  const options = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv
  if (command === undefined || options.includes('--help') || options.includes('-h')) return { help: true }
  if (command === 'start' || command === 'stop') return { usage: START_STOP_USAGE }
  const form = Object.hasOwn(FORMS, command) ? FORMS[command] : undefined
  if (!form || !browserTools().tools.some(tool => tool.name === `browser_${command}`)) return { usage: ANY_USAGE }
  const words = split(rest, form.flags)
  const call = words && form.call(words)
  return call ? { command, ...call } : { usage: `Usage: harness browser ${form.usage}` }
}

export function browserHelp(): string {
  const { tools } = browserTools()
  const width = Math.max(...tools.map(tool => tool.example.length))
  return [
    'Your browser: a Chrome your person can also see and use. Your person starts and stops it.',
    ...tools.map(tool => `  harness browser ${tool.note ? `${tool.example.padEnd(width)}   ${tool.note}` : tool.example}`),
    // Codex moves a shell command to the background after 10 s by default (Task 0's measurements); the CLI waits up
    // to 75 s for navigate (60 s tool, 10 s service, 5 s CLI), so the agent must give it that long.
    'navigate and wait can take up to 75 s: give the command that long.',
  ].join('\n')
}
