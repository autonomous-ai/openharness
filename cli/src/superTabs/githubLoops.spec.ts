/**
 * What Harness writes on GitHub over an hour, as the PM's daemon runs it: the assigner and the merger on one repository whose
 * every write lands (a comment is there to read next pass, a label sticks, a merge closes), the clock moving 30 seconds a pass,
 * and the daemon restarting halfway, as each release restarts it. Nothing may be said twice.
 *
 * Why it is one test of both loops on one live fake: swarm-sandbox, 2026-11-10, the merger posted the same note once a minute
 * on #24, #25 and #26, 46 times each. Its "once for each head" compared the note's words, and the words carried the time of
 * day. Each module's own spec answered from fixed lists that never held what was posted, and moved no clock, so none saw it.
 * lampOS's train bot says each thing once by what it is about (`<PR> <kind> <head>`, train-bot.sh's told list), never by its
 * words; this holds every loop that writes to the same.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Crew } from './assign/crew.js'
import { GitHubAssign } from './githubAssign.js'
import { GitHubMerge, VerdictRecords } from './githubMerge.js'
import { commandRecords } from './commandRecords.fake.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'

type Json = Record<string, unknown>
const REPO = 'acme/app', OPENER = 'deehw'
const START = Date.parse('2026-11-10T04:30:00Z')
const PASS_MS = 30_000, PASSES = 120
const GiB = 1024 ** 3
const PROJECT = { repo: REPO, pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app' }
/** Pip and Juno build on one Mac with no GPU; Faye is the PM. */
const CREW: Crew = {
  builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' }],
  machines: [{ machineId: 'mac', observation: { resources: { os: 'macos', memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } }],
}
const sha = (n: number, v = 0) => createHash('sha1').update(`head-${n}-${v}`).digest('hex')

/** One repository as GitHub's REST API answers it, with ETags, where what Harness writes is there to read next pass. */
function liveGitHub(clock: { now: number }) {
  const iso = () => new Date(clock.now).toISOString()
  const issues = new Map<number, Json>(), pulls = new Map<number, Json>(), comments = new Map<number, Json[]>()
  const runs = new Map<string, Json[]>(), mergeable = new Map<number, string>()
  /** The commits of a pull request that holds more than its own head: one built on another's. */
  const commits = new Map<number, Json[]>()
  const labels: Json[] = ['status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p1', 'p2', 'builder:pip', 'builder:juno', 'needs:gpu'].map(name => ({ name }))
  const sent: Array<{ at: number; method: string; path: string; body: Json }> = []
  let ids = 1000
  const records = commandRecords()
  const touch = (number: number) => {
    const at = iso()
    issues.get(number)!.updated_at = at
    if (pulls.has(number)) pulls.get(number)!.updated_at = at
  }
  const task = (number: number, names: string[], updatedAt = iso(), body = '') =>
    issues.set(number, { number, title: `Task ${number}`, body, state: 'open', labels: names.map(name => ({ name })), user: { login: OPENER },
      author_association: 'MEMBER', created_at: updatedAt, updated_at: updatedAt })
  const pull = (number: number, head: string, extra: Json = {}) => {
    const row = { number, draft: false, state: 'open', base: { ref: 'main' }, head: { sha: head, ref: `pip/${number}`, repo: { full_name: REPO } }, labels: [{ name: 'builder:pip' }],
      user: { login: OPENER }, author_association: 'MEMBER', body: '', updated_at: iso(), ...extra }
    pulls.set(number, row)
    issues.set(number, { ...row, title: `PR ${number}`, pull_request: {}, author_association: 'MEMBER' })
    runs.set(head, [{ name: 'test', status: 'completed', conclusion: 'success' }])
    mergeable.set(number, 'clean')
  }
  const say = (number: number, body: string) => {
    comments.set(number, [...comments.get(number) ?? [], { id: ids++, body, created_at: iso(), updated_at: iso(), author_association: 'MEMBER', user: { login: OPENER } }])
    touch(number)
  }
  const page = (rows: Json[], url: URL) => {
    const per = Number(url.searchParams.get('per_page') ?? 30), at = Number(url.searchParams.get('page') ?? 1)
    return rows.slice((at - 1) * per, at * per)
  }
  const get: GitHubGet = async (path, etag) => {
    const url = new URL(`https://api.github.com${path}`), p = url.pathname, since = url.searchParams.get('since') ?? ''
    const n = (i: number) => Number(p.split('/').at(i))
    const body = p === `/repos/${REPO}` ? { default_branch: 'main' }
      : p === `/repos/${REPO}/issues` ? page([...issues.values()].filter(i => (url.searchParams.get('state') ?? 'open') === 'all' || i.state === (url.searchParams.get('state') ?? 'open'))
        .filter(i => String(i.updated_at) >= since), url)
      : p === `/repos/${REPO}/pulls` ? page([...pulls.values()].filter(r => r.state === (url.searchParams.get('state') ?? 'open')), url)
      : /\/issues\/\d+\/comments$/.test(p) ? page((comments.get(n(-2)) ?? []).map(records.served).filter(c => String(c.updated_at) >= since), url)
      // One issue, which a pull request is too, by its number.
      : /\/issues\/\d+$/.test(p) ? issues.get(n(-1)) ?? null
      : /\/pulls\/\d+\/reviews$/.test(p) ? []
      // Each head its own change, so a push is something new to read; and each holds main's tip, so the one that is ready alone
      // merges on its own (the train is githubTrain.spec.ts).
      : /\/compare\/main\.\.\.[0-9a-f]+$/.test(p) ? { behind_by: 0, files: [{ filename: 'app.py', status: 'modified', changes: 1, patch: `@@ -1 +1 @@\n+${p.split('...').at(-1)}` }] }
      : /\/pulls\/\d+\/commits$/.test(p) ? commits.get(n(-2)) ?? [{ sha: (pulls.get(n(-2))?.head as Json | undefined)?.sha }]
      : p === `/repos/${REPO}/labels` ? page(labels, url)
      : /\/commits\/[0-9a-f]+\/check-runs$/.test(p) ? { check_runs: runs.get(String(p.split('/').at(-2))) ?? [] }
      : /\/commits\/[0-9a-f]+\/status$/.test(p) ? { statuses: [] }
      : /\/pulls\/\d+$/.test(p) ? { mergeable_state: mergeable.get(n(-1)) ?? 'unknown' }
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    return etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body, resetAt: null }
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ at: clock.now, method, path, body: (body ?? {}) as Json })
    const reply = (status: number) => ({ status, etag: null, body: {}, resetAt: null })
    const said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path)
    if (method === 'POST' && said) { say(Number(said[1]), String((body as Json).body)); return reply(201) }
    const tagged = /^\/repos\/acme\/app\/issues\/(\d+)\/labels$/.exec(path)
    if (method === 'POST' && tagged) {
      const number = Number(tagged[1]), row = issues.get(number)!
      for (const name of (body as Json).labels as string[]) if (!(row.labels as Json[]).some(l => l.name === name)) row.labels = [...row.labels as Json[], { name }]
      touch(number)
      return reply(200)
    }
    const untagged = /^\/repos\/acme\/app\/issues\/(\d+)\/labels\/(.+)$/.exec(path)
    if (method === 'DELETE' && untagged) {
      const number = Number(untagged[1]), name = decodeURIComponent(untagged[2]!), row = issues.get(number)!
      if (!(row.labels as Json[]).some(l => l.name === name)) return reply(404)
      row.labels = (row.labels as Json[]).filter(l => l.name !== name)
      touch(number)
      return reply(200)
    }
    if (method === 'POST' && path === `/repos/${REPO}/labels`) {
      if (labels.some(l => l.name === (body as Json).name)) return reply(422)
      labels.push({ name: (body as Json).name })
      return reply(201)
    }
    const merged = /^\/repos\/acme\/app\/pulls\/(\d+)\/merge$/.exec(path)
    if (method === 'PUT' && merged) {
      const number = Number(merged[1]), row = pulls.get(number)
      if (!row || row.state !== 'open' || (row.head as Json).sha !== (body as Json).sha) return reply(409)
      row.state = 'closed'
      issues.get(number)!.state = 'closed'
      touch(number)
      return reply(200)
    }
    return reply(404)
  }
  return { get, send, sent, issues, pulls, comments, commits, runs, mergeable, task, pull, say, authors: records.authors }
}

/** A comment as said, its time of day and the head's short form made alike, so the same thing said at another minute is the same. */
const same = (body: string) => body.replace(/\b\d\d:\d\d\b/g, 'HH:MM')

describe('Harness says each thing once on GitHub, over an hour and a restart (githubAssign.ts, githubMerge.ts)', () => {
  it('writes nothing twice: no comment, no label, no merge', async () => {
    const clock = { now: START }
    const gh = liveGitHub(clock)
    const hours = (h: number) => new Date(START - h * 3_600_000).toISOString()
    // Tasks: two to give, one no machine can start, one taken five hours ago and quiet since.
    gh.task(1, ['size:s', 'p1'])
    gh.task(2, ['size:s'])
    gh.task(3, ['size:s', 'needs:gpu'])
    gh.task(4, ['size:s', 'builder:pip', 'status:taken'], hours(5))
    // Pull requests: a typed READ-OK from the login every agent posts as; failed checks; a conflict; behind; no reader yet;
    // ready to merge; and a HOLD.
    gh.pull(10, sha(10)); gh.say(10, `READ-OK ${sha(10).slice(0, 7)}`)
    gh.pull(11, sha(11)); gh.say(11, `Juno, 11:00, to **Pip**: READ-OK ${sha(11).slice(0, 7)}`)
    gh.runs.set(sha(11), [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'failure' }])
    gh.pull(12, sha(12)); gh.say(12, `Juno, 11:00, to **Pip**: READ-OK ${sha(12).slice(0, 7)}`); gh.mergeable.set(12, 'dirty')
    gh.pull(13, sha(13)); gh.say(13, `Juno, 11:00, to **Pip**: READ-OK ${sha(13).slice(0, 7)}`); gh.mergeable.set(13, 'behind')
    gh.pull(14, sha(14))
    gh.pull(15, sha(15)); gh.say(15, `Juno, 11:00, to **Pip**: READ-OK ${sha(15).slice(0, 7)}`)
    gh.pull(16, sha(16)); gh.say(16, `Juno, 11:05, to **Pip**: HOLD ${sha(16).slice(0, 7)}: the day count is off by one.`)
    // A pull request built on another's: #17 is for task 5 and held by its reader; #18 is for task 6, which comes after 5, is
    // read OK and green, and holds #17's head under its own.
    gh.task(5, ['size:s', 'builder:pip', 'status:taken'])
    gh.task(6, ['size:s', 'builder:pip', 'status:taken'], undefined, 'after #5')
    gh.pull(17, sha(17), { body: 'Closes #5' }); gh.say(17, `Juno, 11:05, to **Pip**: HOLD ${sha(17).slice(0, 7)}: the total is off by one.`)
    gh.pull(18, sha(18), { body: 'Closes #6' }); gh.say(18, `Juno, 11:00, to **Pip**: READ-OK ${sha(18).slice(0, 7)}`)
    gh.commits.set(18, [{ sha: sha(17) }, { sha: sha(18) }])

    const make = () => {
      const deps = { projects: async () => [PROJECT], crew: async () => structuredClone(CREW), get: gh.get, send: gh.send, now: () => clock.now, log: () => {}, records: new VerdictRecords(gh.authors, () => clock.now, () => {}) }
      return { merger: new GitHubMerge(deps), assigner: new GitHubAssign({ ...deps, numbers: { pass: async () => {} }, pmRunning: async () => true, offers: { offer: async () => {}, listed: async () => [] }, say: async () => {} }) }
    }
    let loops = make()
    for (let pass = 0; pass < PASSES; pass++) {
      // Halfway, the daemon restarts (a release): everything held in memory is gone.
      if (pass === PASSES / 2) loops = make()
      // Someone runs the failed checks again on the same head: a third fails too, and GitHub lists them in another order. The
      // same head is still red: nothing new to say.
      if (pass === 20) gh.runs.set(sha(11), [{ name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'build', status: 'completed', conclusion: 'failure' },
        { name: 'test', status: 'completed', conclusion: 'failure' }])
      // A third of the way in, Pip pushes to the pull request whose checks failed; they fail again on the new head, in the
      // other order.
      if (pass === 40) {
        const row = gh.pulls.get(11)!
        row.head = { sha: sha(11, 1), ref: 'pip/11', repo: { full_name: REPO } }
        gh.issues.get(11)!.head = row.head
        gh.runs.set(sha(11, 1), [{ name: 'lint', status: 'completed', conclusion: 'failure' }, { name: 'test', status: 'completed', conclusion: 'failure' }])
        gh.say(11, 'Pip, 12:00: fixed the tests, pushed.')
      }
      // After the restart Pip pushes the fix to #17 and does not touch #18, which then holds #17's earlier commits and not its
      // head. It was told for its head that it lands after #17: it does not land, and is not told again.
      if (pass === 80) {
        const row = gh.pulls.get(17)!
        row.head = { sha: sha(17, 1), ref: 'pip/17', repo: { full_name: REPO } }
        gh.issues.get(17)!.head = row.head
        gh.runs.set(sha(17, 1), [{ name: 'test', status: 'completed', conclusion: 'success' }])
        gh.say(17, 'Pip, 12:20: fixed the total, pushed.')
      }
      await loops.merger.tick()
      if (pass % 2 === 0) await loops.assigner.tick()
      clock.now += PASS_MS
    }

    // What Harness said, by issue or pull request, made alike across minutes: never the same thing twice.
    const harness = new Map<number, string[]>()
    for (const [number, list] of gh.comments) harness.set(number, list.map(c => String(c.body)).filter(body => body.startsWith('Harness, ')).map(same))
    for (const [number, said] of harness) expect(said, `#${number}: ${JSON.stringify(said, null, 1)}`).toEqual([...new Set(said)])
    // And every write once: a label on an issue, a label off, a merge.
    const writes = gh.sent.filter(s => s.method !== 'POST' || !s.path.endsWith('/comments'))
      .flatMap(s => s.method === 'POST' && /\/labels$/.test(s.path) && Array.isArray(s.body.labels) ? (s.body.labels as string[]).map(l => `${s.method} ${s.path} ${l}`) : [`${s.method} ${s.path}`])
    expect(writes, JSON.stringify(writes, null, 1)).toEqual([...new Set(writes)])

    // It did run through each case, so the hour proves something: each said what it is for, once.
    const one = (number: number, pattern: RegExp) => expect((harness.get(number) ?? []).filter(body => pattern.test(body)), `#${number}`).toHaveLength(1)
    one(10, /not merged yet at \w+: the READ-OK from deehw is typed/)
    one(10, /to \*\*Juno\*\*: please read this pull request/)
    one(12, /not merged yet at \w+: it conflicts with main/)
    one(13, /not merged yet at \w+: it is behind main/)
    // No verdict in 30 minutes: another reader is asked too (Swarm plan, step 1, item 1), each reader once in the hour.
    const asked14 = (harness.get(14) ?? []).filter(body => /: please read this pull request/.test(body)).map(body => /\*\*(\w+)\*\*/.exec(body)?.[1])
    expect(asked14, '#14').toHaveLength(2)
    expect(new Set(asked14).size, '#14').toBe(2)
    one(15, /: merged\. READ-OK on \w+ by Juno, checks green\./)
    one(3, /nobody can start this yet: it needs gpu/)
    one(4, /nothing has moved on this task for/)
    // Failed checks are said for the head Juno read. Pip's push fails its checks again: Juno is not asked to read the new head
    // while they fail, as a fix is another head, read again (anh Dee, 2026-11-11: "never spam github").
    one(11, /not merged yet at \w+: checks failed/)
    expect((harness.get(11) ?? []).filter(body => /please read it again/.test(body)), '#11').toEqual([])
    expect(gh.sent.filter(s => s.method === 'PUT')).toHaveLength(1)
    expect(harness.get(16) ?? []).toEqual([])
    // The one built on #17 is told once, in the hour and across the restart and the push, what it waits for; #17's reader
    // is asked once to read its new head.
    expect((harness.get(18) ?? []).filter(body => body.includes('not merged yet'))).toEqual([expect.stringMatching(/: it lands after #17, whose commits it carries \(its head \w+\)\.$/)])
    one(17, /to \*\*Juno\*\*: the head is now \w+, after your HOLD on \w+: please read it again/)
    expect(gh.pulls.get(18)!.state).toBe('open')
  }, 60_000)

  // anh Dee, 2026-11-11: "never spam github as user accounts could be banned". A day nobody moves: a reader that never reads, checks
  // never fixed, a pull request on hold, a task taken and left, one nobody can start, a branch behind and one conflicting. What
  // Harness says of each is said once, and a few things in all, however long it waits.
  it('says each thing once over a day nobody moves, and a few things in all', async () => {
    const clock = { now: START }
    const gh = liveGitHub(clock)
    gh.task(3, ['size:s', 'needs:gpu'])
    gh.task(4, ['size:s', 'builder:pip', 'status:taken'])
    gh.task(5, ['size:m', 'builder:juno', 'status:taken'])
    gh.pull(20, sha(20))
    gh.pull(21, sha(21)); gh.runs.set(sha(21), [{ name: 'test', status: 'completed', conclusion: 'failure' }])
    gh.pull(22, sha(22), { labels: [{ name: 'builder:pip' }, { name: 'hold' }] })
    gh.pull(23, sha(23)); gh.say(23, `Juno, 04:00, to **Pip**: READ-OK ${sha(23).slice(0, 7)}`); gh.mergeable.set(23, 'behind')
    gh.pull(24, sha(24)); gh.say(24, `Juno, 04:00, to **Pip**: READ-OK ${sha(24).slice(0, 7)}`); gh.mergeable.set(24, 'dirty')
    const make = () => {
      const deps = { projects: async () => [PROJECT], crew: async () => structuredClone(CREW), get: gh.get, send: gh.send, now: () => clock.now, log: () => {}, records: new VerdictRecords(gh.authors, () => clock.now, () => {}) }
      return { merger: new GitHubMerge(deps), assigner: new GitHubAssign({ ...deps, numbers: { pass: async () => {} }, pmRunning: async () => true, offers: { offer: async () => {}, listed: async () => [] }, say: async () => {} }) }
    }
    let loops = make()
    // A pass every five minutes for a day, the daemon restarting every six hours, as releases restart it.
    for (let pass = 0; pass < 288; pass++) {
      if (pass % 72 === 71) loops = make()
      await loops.merger.tick()
      await loops.assigner.tick()
      clock.now += 5 * 60_000
    }
    const harness = new Map<number, string[]>()
    for (const [number, list] of gh.comments) harness.set(number, list.map(c => String(c.body)).filter(body => body.startsWith('Harness, ')).map(same))
    for (const [number, said] of harness) expect(said, `#${number}: ${JSON.stringify(said, null, 1)}`).toEqual([...new Set(said)])
    // Measured 2026-11-11: eleven in the day. Each stuck pull request is said once (behind, conflicting); the one nobody reads asks
    // a builder, then the PM half an hour on; the one needing a GPU says so once; each task left is asked after at 4 h and given
    // to the other builder at 8 h. The failing one and the held one say nothing on GitHub: their builder's turn's end tells it.
    const count = [...harness.values()].reduce((sum, said) => sum + said.length, 0)
    expect(count, JSON.stringify(Object.fromEntries(harness), null, 1)).toBeLessThanOrEqual(12)
    // Every write once. A take-back takes status:taken off twice in the same moment, in case its builder took it between
    // (githubAssign.ts giveBack): one write.
    const writes = [...new Set(gh.sent.filter(s => s.method !== 'POST' || !s.path.endsWith('/comments'))
      .flatMap(s => s.method === 'POST' && /\/labels$/.test(s.path) && Array.isArray(s.body.labels) ? (s.body.labels as string[]).map(l => `${s.at} ${s.method} ${s.path} ${l}`) : [`${s.at} ${s.method} ${s.path}`]))]
      .map(write => write.slice(write.indexOf(' ') + 1))
    expect(writes, JSON.stringify(writes, null, 1)).toEqual([...new Set(writes)])
  }, 120_000)
})
