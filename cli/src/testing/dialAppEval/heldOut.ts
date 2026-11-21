// Held out (docs/plans/2026-11-21-dial-app-eval-design.md, Held-out set): whoever fixes a failing group of the dial eval
// does not read this file.
//
// Scored and reported apart, never in the headline score. A function, not a list: the catalog imports it and it uses
// the catalog's builders, so it is called once the catalog has them.
import { chatgptGhost, claudeGhost, claudeSession, claudeSessions, keys, listed, S, scenario, threads, titleOf } from './catalog.js'
import type { Scenario } from './types.js'

export function heldOut(): Scenario[] {
  const s16 = keys('s', 1, 16, 2)
  return [
    scenario({
      id: 'CH1', app: 'claude', title: 'Sixteen sessions and a new one: the oldest leaves, the new one is first',
      dims: ['D1'], tiers: ['a'], sessions: [...claudeSessions(s16), claudeSession('s00', 30 * S), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: s16 },
        ...listed('claude', s16),
        { label: 'new', kind: 'claude.write', sessions: ['s00'] },
      ],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['s00', ...s16.slice(0, 15)], after: 'new' }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['s00', ...s16.slice(0, 15), 'z'], after: 'new' }],
    }, true),
    scenario({
      id: 'CH2', app: 'claude', title: 'A long title with an emoji: the row\'s name is the title as the daemon\'s title rule makes it',
      dims: ['D1'], tiers: ['a'],
      sessions: [claudeSession('a', 60 * S, { title: `Eval 🎉 ${'abcdefghij'.repeat(7)}` }), claudeGhost],
      steps: [{ kind: 'claude.write', sessions: ['a'] }],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a'] }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'z'] }],
    }, true),
    scenario({
      id: 'CH3', app: 'claude', title: 'Voice on the focused session while another is working: only the focused one gets it',
      dims: ['D5'], sessions: [...claudeSessions(['a', 'b']), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: ['a', 'b'] },
        { kind: 'hook', session: 'a', event: 'start' },
        { kind: 'hook', session: 'b', event: 'start' },
        { kind: 'hook', session: 'b', event: 'turn-start' },
        ...listed('claude', ['a', 'b']),
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'a', text: 'Eval words for alpha.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for alpha.', after: 'voice' }],
    }, true),
    scenario({
      id: 'XH1', app: 'chatgpt', title: 'A thread renamed after it is listed: its row\'s name updates',
      dims: ['D1'], tiers: ['a'], sessions: [...threads(['t1', 't2']), chatgptGhost],
      steps: [
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        ...listed('chatgpt', ['t1', 't2']),
        // Only Codex's names change: the threads' rows stay as they were.
        { label: 'rename', kind: 'codex.write', sessions: [], names: { t1: 'Eval Renamed' } },
      ],
      checks: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 't2'], after: 'rename' }],
      probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'chatgpt', expect: ['t1', 't2', 'z'], after: 'rename' }],
    }, true),
    scenario({
      id: 'XH2', app: 'chatgpt', title: 'A thread opened in the app while the dial shows the Claude app\'s page: the dial moves to it',
      dims: ['D2'], sessions: [claudeSession('a', 60 * S), ...threads(['t1', 't2']), chatgptGhost], world: { front: 'claude' },
      // The ChatGPT page opens on its first tile, t1: only the title line can land the dial on t2.
      steps: [
        { kind: 'claude.write', sessions: ['a'] },
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        ...listed('claude', ['a']),
        { label: 'front', kind: 'front', app: 'chatgpt' },
        ...listed('chatgpt', ['t1', 't2']),
        { label: 'title', kind: 'thread', title: titleOf('t2') },
      ],
      checks: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 't2', after: 'title' }],
      probes: [{ id: 'focus', kind: 'focus', dim: 'D2', session: 'z', after: 'title' }],
    }, true),
    scenario({
      id: 'XH3', app: 'chatgpt', title: 'Voice 200 ms after a follow moved the dial: the words reach the newly focused thread',
      dims: ['D5'], sessions: [...threads(['t1', 't2']), chatgptGhost],
      steps: [
        { kind: 'codex.write', sessions: ['t1', 't2'] },
        ...listed('chatgpt', ['t1', 't2']),
        { kind: 'front', app: 'chatgpt' },
        { label: 'follow', kind: 'thread', title: titleOf('t2') },
        { kind: 'wait', ms: 200 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for two.', target: 't2' },
      ],
      checks: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 't2', text: 'Eval words for two.', after: 'voice' }],
      probes: [{ id: 'voice', kind: 'voice', dim: 'D5', session: 'z', text: 'Eval words for two.', after: 'voice' }],
    }, true),
  ]
}
