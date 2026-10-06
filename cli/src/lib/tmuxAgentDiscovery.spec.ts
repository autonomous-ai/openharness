import { expect, it } from 'vitest'
import { parsePanes } from './tmuxAgentDiscovery.js'

it('parses printable tmux separators without truncating a pipe in cwd, and the owner tag after it', () => {
  expect(parsePanes('%1|42|harness-claude-1|/work/a|b|\n%2|84|mysession|/tmp|0123abcd\n')).toEqual([
    { tmuxPane: '%1', rootPid: 42, tmuxSessionName: 'harness-claude-1', cwd: '/work/a|b', owner: '' },
    { tmuxPane: '%2', rootPid: 84, tmuxSessionName: 'mysession', cwd: '/tmp', owner: '0123abcd' },
  ])
  // A listing in the format before the tag: a pane nobody tagged.
  expect(parsePanes('%3|7|harness-codex-1|/work\n')).toEqual([
    { tmuxPane: '%3', rootPid: 7, tmuxSessionName: 'harness-codex-1', cwd: '/work', owner: '' },
  ])
})
