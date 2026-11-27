import { expect, it } from 'vitest'
import { frontAppId, FRONT_NONE } from '../../cable/hosts/frontApp.js'
import { observedAgentId } from '../../cable/hosts/observed.js'
import { claudeSession, itermSession, orcaSession, vscode } from './catalog.js'
import { APPS, DIMENSIONS, EDITORS, PAGE, WEIGHTS, agentIdOf, engineOf, frontName, hookHandle, itermPlaceOf, orcaAgentSessionId, orcaPaneHandle,
  orcaTerminalHandle, orcaWorktreeId, pageId, placeOf, resultKey, sessionPages, type Platform } from './types.js'

const id = '00000000-0000-4000-8000-0000000000e1'

it('agentIdOf follows the session\'s engine', () => {
  expect(agentIdOf({ app: 'cursor', id, place: 'agent' })).toBe(observedAgentId('cursor', id))
  expect(agentIdOf({ app: 'vscode', id, engine: 'codex' })).toBe(observedAgentId('codex', id))
  expect(agentIdOf({ app: 'cursor', id, place: 'terminal', engine: 'codex' })).toBe(observedAgentId('codex', id))
  expect(agentIdOf({ app: 'vscode', id, place: 'panel' })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'cursor', id })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'claude', id })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ app: 'chatgpt', id })).toBe(observedAgentId('codex', id))
})

it("a resting Orca chat's row is Orca's own, by its Orca session; a live one's is its engine's, as the hooked copy's", () => {
  expect(orcaAgentSessionId('c')).toBe('eval-orca-c')
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'resting' })).toBe(observedAgentId('orca', 'eval-orca-c'))
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'resting', engine: 'codex' })).toBe(observedAgentId('orca', 'eval-orca-c'))
  expect(agentIdOf({ key: 'c', app: 'orca', id, chat: 'live' })).toBe(observedAgentId('claude', id))
  expect(agentIdOf({ key: 'c', app: 'orca', id })).toBe(observedAgentId('claude', id))
  expect(() => agentIdOf({ app: 'orca', id, chat: 'resting' })).toThrow('a resting Orca chat is named by its key')
})

it('an editor session runs in a terminal unless it says otherwise; the base apps have no place', () => {
  expect(placeOf({ app: 'vscode' })).toBe('terminal')
  expect(placeOf({ app: 'cursor', place: 'agent' })).toBe('agent')
  expect(placeOf({ app: 'claude' })).toBeUndefined()
  expect(placeOf({ app: 'chatgpt' })).toBeUndefined()
  expect(engineOf({ app: 'cursor', place: 'agent', engine: 'claude' })).toBe('claude')
})

it("VS Code has no agent of its own: a session in place 'agent' that is not Cursor's is refused", () => {
  expect(() => placeOf({ app: 'vscode', place: 'agent' })).toThrow("vscode has no agent of its own: only Cursor's sessions run in place 'agent'")
  expect(() => engineOf({ app: 'vscode', place: 'agent' })).toThrow("vscode has no agent of its own")
  expect(() => agentIdOf({ app: 'vscode', id, place: 'agent', engine: 'claude' })).toThrow("vscode has no agent of its own")
})

it('PAGE names the editors\' pages by the wire\'s app ids', () => {
  expect(PAGE).toMatchObject({ claude: 'claude', chatgpt: 'codex', vscode: 'vscode', cursor: 'cursor' })
})

it("PAGE names Orca's page orca", () => {
  expect(PAGE.orca).toBe('orca')
})

it("PAGE names iTerm2's page iterm", () => {
  expect(PAGE.iterm).toBe('iterm')
})

it("pageId names tmux and herdr as themselves and an app by PAGE", () => {
  expect(pageId('tmux')).toBe('tmux')
  expect(pageId('herdr')).toBe('herdr')
  expect(pageId('chatgpt')).toBe('codex')
})

it("sessionPages: an iTerm2 session in tmux or herdr is on iTerm2's page and the multiplexer's; a plain one on its app's alone", () => {
  expect(sessionPages(itermSession('b', { place: 'tmux' }))).toEqual(['iterm', 'tmux'])
  expect(sessionPages(itermSession('c', { place: 'herdr' }))).toEqual(['iterm', 'herdr'])
  expect(sessionPages(itermSession('a'))).toEqual(['iterm'])
  expect(sessionPages(claudeSession('a', 0))).toEqual(['claude'])
})

it("sessionPages: Claude Code in the person's tmux in an editor's terminal or an Orca pane is on that app's page and tmux's", () => {
  expect(sessionPages(vscode('a', { tmux: true }))).toEqual(['vscode', 'tmux'])
  expect(sessionPages(vscode('a'))).toEqual(['vscode'])
  expect(sessionPages(orcaSession('c', { tmux: true }))).toEqual(['orca', 'tmux'])
})

it('APPS is the six apps, iTerm2 last', () => {
  expect(APPS).toEqual(['claude', 'chatgpt', 'vscode', 'cursor', 'orca', 'iterm'])
  expect(EDITORS).toEqual(['vscode', 'cursor'])
})

it('itermPlaceOf is tab by default and undefined off iTerm2', () => {
  expect(itermPlaceOf({ app: 'iterm' })).toBe('tab')
  expect(itermPlaceOf({ app: 'iterm', place: 'herdr' })).toBe('herdr')
  expect(itermPlaceOf({ app: 'vscode' })).toBeUndefined()
  expect(itermPlaceOf({ app: 'orca' })).toBeUndefined()
  // placeOf answers the editors' places alone.
  expect(placeOf({ app: 'iterm', place: 'tmux' })).toBeUndefined()
})

it('an iTerm2 place on a VS Code session, an editor place or tmux: true on an iTerm2 session, are refused', () => {
  expect(() => placeOf({ app: 'vscode', place: 'tmux' })).toThrow("vscode has no tmux place: only iTerm2's sessions run in a tab, tmux or herdr")
  expect(() => engineOf({ app: 'claude', place: 'tab' })).toThrow('claude has no tab place')
  expect(() => itermPlaceOf({ app: 'iterm', place: 'terminal' })).toThrow('iTerm2 has no terminal place: its sessions run in a tab, tmux or herdr')
  expect(() => itermPlaceOf({ app: 'iterm', place: 'panel' })).toThrow('iTerm2 has no panel place')
  expect(() => engineOf({ app: 'iterm', place: 'agent' })).toThrow('iterm has no agent of its own')
  expect(() => itermPlaceOf({ app: 'iterm', tmux: true })).toThrow("an iTerm2 session's tmux is its place: tmux: true is refused")
})

it("orcaPaneHandle gives the session's handle at its first launch and 8d0n at its nth; a session whose hooks name none is laid out on its key's handle, and hookHandle gives it none", () => {
  // o1's bytes are 6f31.
  expect(orcaTerminalHandle('o1')).toBe('term_00000000-0000-4000-8d00-000000006f31')
  expect(orcaPaneHandle({ key: 'o1' }, 0)).toBe('term_00000000-0000-4000-8d00-000000006f31')
  expect(orcaPaneHandle({ key: 'o1' }, 2)).toBe('term_00000000-0000-4000-8d02-000000006f31')
  expect(hookHandle({ key: 'o1' }, 1)).toBe('term_00000000-0000-4000-8d01-000000006f31')
  expect(orcaPaneHandle({ key: 'o1', handle: 'none' }, 0)).toBe(orcaTerminalHandle('o1'))
  expect(orcaPaneHandle({ key: 'o1', handle: 'none' }, 1)).toBe('term_00000000-0000-4000-8d01-000000006f31')
  expect(hookHandle({ key: 'o1', handle: 'none' }, 0)).toBeUndefined()
  expect(hookHandle({ key: 'o1', handle: 'none' }, 1)).toBeUndefined()
  // A chat's hooks name no handle: no terminal holds it.
  expect(hookHandle({ key: 'o1', chat: 'live' }, 0)).toBeUndefined()
})

it('orcaWorktreeId is eval-repo::/work/eval-<key>', () => {
  expect(orcaWorktreeId('w1')).toBe('eval-repo::/work/eval-w1')
})

it("every app but Orca and iTerm2 maps through frontAppId to its own page from its front name on every platform; Orca's macOS name maps to orca", () => {
  for (const platform of ['darwin', 'linux', 'win32'] as Platform[]) {
    for (const app of APPS.filter((a) => a !== 'orca' && a !== 'iterm')) {
      expect(frontAppId(frontName(platform, app)), `${platform} ${app}`).toBe(PAGE[app])
    }
    expect(frontAppId(frontName(platform, 'other')), platform).toBe(FRONT_NONE)
  }
  expect(frontAppId(frontName('darwin', 'orca'))).toBe('orca')
  // Linux's and Windows' own names for Orca, which the dial is graded on there whether or not the product tells them.
  expect(frontName('linux', 'orca')).toBe('orca-ide')
  expect(frontName('win32', 'orca')).toBe('orca.exe')
})

it("iTerm2's macOS front name maps through frontAppId to iterm, and frontName throws for iTerm2 on Linux and Windows", () => {
  expect(frontName('darwin', 'iterm')).toBe('com.googlecode.iterm2')
  expect(frontAppId(frontName('darwin', 'iterm'))).toBe(PAGE.iterm)
  expect(() => frontName('linux', 'iterm')).toThrow('iterm has no front name on linux')
  expect(() => frontName('win32', 'iterm')).toThrow('iterm has no front name on win32')
})

it('the weights are the spec\'s and sum to 100', () => {
  expect(WEIGHTS).toEqual({ D1: 15, D2: 15, D3: 15, D4: 10, D5: 25, D6: 5, D7: 10, D8: 5 })
  expect(DIMENSIONS.reduce((sum, d) => sum + WEIGHTS[d], 0)).toBe(100)
})

it('resultKey joins tier, platform, scenario and check with /', () => {
  expect(resultKey({ tier: 'a', platform: 'linux', scenario: 'C1', check: 'ring.recall' })).toBe('a/linux/C1/ring.recall')
})
