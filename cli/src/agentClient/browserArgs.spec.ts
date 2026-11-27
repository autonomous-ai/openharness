import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHelp, parseBrowserArgs, START_STOP_USAGE, type BrowserCall } from './browserArgs.js'
import { browserTools } from '../lib/browserToolsAsset.js'

/** Splits a line as a shell would, for the examples' own quoting: spaces part words, quotes join them. */
function shellWords(line: string): string[] {
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) word += line[++i]
      else word += c
    } else if (c === '"' || c === "'") { quote = c; word ??= '' }
    else if (c === ' ') { if (word !== undefined) words.push(word); word = undefined }
    else word = (word ?? '') + c
  }
  if (word !== undefined) words.push(word)
  return words
}

type Schema = { type?: string; enum?: unknown[]; items?: Schema }
/** Whether a value is of the JSON Schema type the tool asks for, and in its enum when it has one. */
function fits(value: unknown, schema: Schema): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false
  switch (schema.type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'array': return Array.isArray(value) && value.every(item => fits(item, schema.items ?? {}))
    default: return false
  }
}

const call = (line: string): BrowserCall | { usage: string } | { help: true } => parseBrowserArgs(shellWords(line))

describe('harness browser arguments', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('every tool has an example, and its example parses to a call its schema takes', () => {
    const { tools } = browserTools()
    expect(tools).toHaveLength(11)
    for (const tool of tools) {
      expect(tool.example, tool.name).toBeTruthy()
      const parsed = call(tool.example)
      expect(parsed, tool.name).toHaveProperty('command', tool.name.replace(/^browser_/, ''))
      const { args } = parsed as BrowserCall
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>
      for (const key of tool.inputSchema.required ?? []) expect(args, `${tool.name} ${key}`).toHaveProperty(key)
      for (const [key, value] of Object.entries(args)) {
        expect(properties[key], `${tool.name} ${key}`).toBeDefined()
        expect(fits(value, properties[key]), `${tool.name} ${key}`).toBe(true)
      }
    }
  })

  it('the help lists every tool once, in order, and needs nothing but the JSON', () => {
    const lines = browserHelp().split('\n')
    expect(lines[0]).toBe('Your browser: a Chrome your person can also see and use. Your person starts and stops it.')
    const { tools } = browserTools()
    expect(lines.slice(1, 1 + tools.length)).toEqual(tools.map(tool => expect.stringMatching(
      new RegExp(`^  harness browser ${tool.example.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s{3,}${tool.note ?? ''})?$`))))
    for (const [i, tool] of tools.entries()) if (tool.note) expect(lines[1 + i].endsWith(`   ${tool.note}`), tool.name).toBe(true)
    expect(lines.at(-1)).toBe('navigate and wait can take up to 75 s: give the command that long.')
    expect(lines).toHaveLength(tools.length + 2)

    vi.stubGlobal('__BROWSER_TOOLS_JSON__', JSON.stringify({ tools: [
      { name: 'browser_back', description: 'd', example: 'back', inputSchema: { type: 'object' } },
      { name: 'browser_click', description: 'd', example: 'click e1', note: 'a click', inputSchema: { type: 'object' } },
    ] }))
    expect(browserHelp().split('\n').slice(1, 3)).toEqual(['  harness browser back', '  harness browser click e1   a click'])
  })

  it('the notes line up, as the spec shows them', () => {
    const lines = browserHelp().split('\n')
    expect(lines).toContain('  harness browser navigate https://example.com   open a page in the current tab')
    expect(lines).toContain('  harness browser type e7 "hello" --submit       replaces what the field holds; --submit presses Enter')
    expect(lines).toContain('  harness browser click e12')
  })

  it.each([
    ['navigate https://example.com', { command: 'navigate', args: { url: 'https://example.com' } }],
    ['back', { command: 'back', args: {} }],
    ['snapshot', { command: 'snapshot', args: {} }],
    ['click e12', { command: 'click', args: { ref: 'e12' } }],
    ['type e7 hello', { command: 'type', args: { ref: 'e7', text: 'hello' } }],
    ['type e7 "hello world" --submit', { command: 'type', args: { ref: 'e7', text: 'hello world', submit: true } }],
    ['type e7 --submit hello', { command: 'type', args: { ref: 'e7', text: 'hello', submit: true } }],
    ['press Enter', { command: 'press', args: { key: 'Enter' } }],
    ['select e9 "Viet Nam"', { command: 'select', args: { ref: 'e9', values: ['Viet Nam'] } }],
    ['select e9 a b', { command: 'select', args: { ref: 'e9', values: ['a', 'b'] } }],
    ['scroll 600', { command: 'scroll', args: { dy: 600 } }],
    ['scroll -300', { command: 'scroll', args: { dy: -300 } }],
    ['scroll 2.5', { command: 'scroll', args: { dy: 2.5 } }],
    ['screenshot', { command: 'screenshot', args: {} }],
    ['tabs', { command: 'tabs', args: { action: 'list' } }],
    ['tabs list', { command: 'tabs', args: { action: 'list' } }],
    ['tabs new', { command: 'tabs', args: { action: 'new' } }],
    ['tabs select 2', { command: 'tabs', args: { action: 'select', index: 2 } }],
    ['tabs close', { command: 'tabs', args: { action: 'close' } }],
    ['tabs close 1', { command: 'tabs', args: { action: 'close', index: 1 } }],
    ['wait Inbox', { command: 'wait', args: { text: 'Inbox' } }],
    ['wait --ms 2000', { command: 'wait', args: { ms: 2000 } }],
    ['wait -- --ms', { command: 'wait', args: { text: '--ms' } }],
  ])('%s', (line, expected) => {
    expect(call(line)).toEqual(expected)
  })

  it.each([[''], ['--help'], ['-h'], ['type --help'], ['navigate -h']])('"%s" asks for the help', line => {
    expect(call(line)).toEqual({ help: true })
  })

  it('start and stop are the usage line that names the person', () => {
    expect(START_STOP_USAGE).toBe('Only your person starts and stops your browser: Browser in your chat.')
    expect(call('start')).toEqual({ usage: START_STOP_USAGE })
    expect(call('stop')).toEqual({ usage: START_STOP_USAGE })
  })

  it.each([
    ['fly', 'Usage: harness browser <command>. The commands: harness browser --help'],
    ['constructor', 'Usage: harness browser <command>. The commands: harness browser --help'],
    ['navigate', 'Usage: harness browser navigate <url>'],
    ['click', 'Usage: harness browser click <ref>'],
    ['type e7', 'Usage: harness browser type <ref> <text> [--submit]'],
    ['type e7 a b', 'Usage: harness browser type <ref> <text> [--submit]'],
    ['type e7 a --enter', 'Usage: harness browser type <ref> <text> [--submit]'],
    ['type e7 a --submit --submit', 'Usage: harness browser type <ref> <text> [--submit]'],
    ['select e9', 'Usage: harness browser select <ref> <value>…'],
    ['scroll down', 'Usage: harness browser scroll <dy>'],
    ['scroll ""', 'Usage: harness browser scroll <dy>'],
    ['scroll 1e3', 'Usage: harness browser scroll <dy>'],
    ['tabs select', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['tabs select two', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['tabs select -1', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['tabs close 1 2', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['tabs new 1', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['tabs open', 'Usage: harness browser tabs [list | new | select <n> | close [<n>]]'],
    ['wait', 'Usage: harness browser wait <text> | wait --ms <n>'],
    ['wait --ms', 'Usage: harness browser wait <text> | wait --ms <n>'],
    ['wait --ms soon', 'Usage: harness browser wait <text> | wait --ms <n>'],
    ['wait --ms 2000 Inbox', 'Usage: harness browser wait <text> | wait --ms <n>'],
    ['back now', 'Usage: harness browser back'],
    ['navigate a b', 'Usage: harness browser navigate <url>'],
  ])('"%s" is usage', (line, usage) => {
    expect(call(line)).toEqual({ usage })
  })

  it('a command the JSON does not name is usage', () => {
    vi.stubGlobal('__BROWSER_TOOLS_JSON__', JSON.stringify({ tools: [
      { name: 'browser_back', description: 'd', example: 'back', inputSchema: { type: 'object' } },
    ] }))
    expect(call('back')).toEqual({ command: 'back', args: {} })
    expect(call('click e1')).toEqual({ usage: 'Usage: harness browser <command>. The commands: harness browser --help' })
  })

  it('text that looks like a flag is typed as text, after --', () => {
    expect(call('type e7 -- --submit')).toEqual({ command: 'type', args: { ref: 'e7', text: '--submit' } })
    expect(call('type e7 --submit -- --help')).toEqual({ command: 'type', args: { ref: 'e7', text: '--help', submit: true } })
    expect(call('type e7 -- -')).toEqual({ command: 'type', args: { ref: 'e7', text: '-' } })
  })

  it('type e7 - asks for standard input', () => {
    expect(call('type e7 -')).toEqual({ command: 'type', args: { ref: 'e7' }, stdin: 'text' })
    expect(call('type e7 - --submit')).toEqual({ command: 'type', args: { ref: 'e7', submit: true }, stdin: 'text' })
  })

  it('text keeps its quotes and new lines', () => {
    expect(parseBrowserArgs(['type', 'e7', 'a "b"\nc'])).toEqual({ command: 'type', args: { ref: 'e7', text: 'a "b"\nc' } })
    expect(call('type e7 "a \\"b\\"\nc"')).toEqual({ command: 'type', args: { ref: 'e7', text: 'a "b"\nc' } })
    expect(parseBrowserArgs(['type', 'e7', ''])).toEqual({ command: 'type', args: { ref: 'e7', text: '' } })
  })
})
