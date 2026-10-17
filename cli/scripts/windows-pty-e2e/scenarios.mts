import { execFileSync } from 'node:child_process'
import { Client, Stream, log, sleep, tail, screenText } from './driver.mts'

type Ctx = { c: Client; args: string[]; state: Record<string, any>; save: () => void; create: (e: string, cwd?: string, extra?: Record<string, unknown>) => Promise<any>; waitReady: (id: string, ms?: number) => Promise<any>; brief: (a: any) => any }

const results: Array<{ check: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ check: name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function attempt(name: string, fn: () => Promise<string | void>) {
  try { check(name, true, (await fn()) ?? '') } catch (e) { check(name, false, (e as Error).message) }
}
function summary() {
  log(`SUMMARY ${results.filter((r) => r.ok).length}/${results.length} passed`)
  for (const r of results.filter((r) => !r.ok)) log(`  FAILED ${r.check}`)
}

export const UNICODE = 'Tiếng Việt: Xin chào thế giới — 中文：你好世界 — 日本語：こんにちは — 한국어: 안녕하세요 — 🎉🚀👍'
export const UNICODE_PARTS = ['Tiếng Việt: Xin chào thế giới', '你好世界', 'こんにちは', '안녕하세요', '🎉']

/** 300 lines × 100 printable ASCII characters = 30,000 characters, and the PowerShell-side checksum of them. */
export function bigText(): { lines: string[]; total: number; hash: number } {
  const lines: string[] = []
  for (let i = 0; i < 300; i++) {
    let line = `L${String(i).padStart(3, '0')} `
    for (let j = 0; line.length < 100; j++) line += String.fromCharCode(33 + ((i * 7 + j * 13) % 94))
    lines.push(line.replace(/'/g, '#'))
  }
  let hash = 0
  let total = 0
  for (const l of lines) { total += l.length; for (const ch of l) hash = (hash * 31 + ch.charCodeAt(0)) % 1000000007 }
  return { lines, total, hash }
}

const occurrences = (text: string, part: string) => text.split(part).length - 1
const keyframeRows = (k: { text: string }) => (k.text.match(/\u001b\[(\d+);1H/g) ?? []).length

async function psChecks(c: Client, s: Stream, label: string) {
  const p0 = Date.now()
  await attempt(`${label}: prompt shows on the stream`, async () => {
    await c.waitScreen(s, `${label} prompt`, 90_000, (t) => /PS [A-Z]:\\.*>\s*$/m.test(t))
    return `after ${Date.now() - p0} ms; raw output so far ${JSON.stringify(s.output.slice(0, 120))}`
  })
  await attempt(`${label}: type a command, see its output`, async () => {
    c.input(s, "Write-Output ('E2E_' + (40+2))\r")
    const t = await c.waitScreen(s, 'E2E_42', 15_000, (t) => /^E2E_42\s*$/m.test(t))
    return tail(t, 3).replace(/\n/g, ' | ')
  })
  await attempt(`${label}: paste 30 KB (300 lines) through ReadLine, count + checksum`, async () => {
    const { lines, total, hash } = bigText()
    c.input(s, "$n=0;$h=[long]0; while(($l=[Console]::In.ReadLine()) -ne 'END'){ $n+=$l.Length; foreach($ch in $l.ToCharArray()){$h=($h*31+[int]$ch)%1000000007} }; \"TOTAL=$n HASH=$h\"\r")
    await sleep(1500)
    const t0 = Date.now()
    c.paste(s, lines.join('\r') + '\rEND\r')
    const want = `TOTAL=${total} HASH=${hash}`
    const t = await c.waitScreen(s, want, 60_000, (t) => t.includes(want) || /TOTAL=\d+/.test(t))
    if (!t.includes(want)) throw new Error(`got ${t.match(/TOTAL=\d+ HASH=\d+/)?.[0]}, want ${want}`)
    return `${want} (${Buffer.byteLength(lines.join('\r'))} bytes, ${Date.now() - t0} ms)`
  })
  await attempt(`${label}: paste Vietnamese/CJK/Korean/emoji, echoed by PowerShell`, async () => {
    c.input(s, '\u000c') // clear the screen so earlier lines do not count
    await sleep(500)
    c.paste(s, `Write-Output '${UNICODE}'`)
    await sleep(800)
    c.input(s, '\r')
    const t = await c.waitScreen(s, 'unicode echo', 15_000, (t) => t.split('\n').some((l) => l.trim() === UNICODE) && t.includes("Write-Output 'Tiếng Việt"))
    return `output line == pasted text: ${t.split('\n').find((l) => l.trim() === UNICODE)?.trim()}`
  })
  await attempt(`${label}: typed (not pasted) Unicode reaches PowerShell`, async () => {
    c.input(s, '\u000c'); await sleep(500)
    await c.typeSlow(s, "Write-Output 'gõ tiếng Việt 汉字 ✓'", 3, 30)
    c.input(s, '\r')
    const t = await c.waitScreen(s, 'typed unicode', 15_000, (t) => occurrences(t, 'gõ tiếng Việt 汉字 ✓') >= 2)
    return tail(t, 2).replace(/\n/g, ' | ')
  })
  await attempt(`${label}: resize 120x40 → 100x30, the shell sees it`, async () => {
    const k = await c.resize(s, 100, 30)
    const rows = keyframeRows(k)
    c.input(s, '\u000c'); await sleep(500)
    c.input(s, "'SIZE=' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height\r")
    const t = await c.waitScreen(s, 'SIZE=100x30', 15_000, (t) => /SIZE=100x30/.test(t))
    if (rows !== 30) throw new Error(`keyframe has ${rows} rows`)
    return `keyframe rows=${rows}; ${t.match(/SIZE=\d+x\d+/)?.[0]}`
  })
  await attempt(`${label}: resize back to 120x40`, async () => {
    const k = await c.resize(s, 120, 40)
    c.input(s, "'SIZE=' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height\r")
    const t = await c.waitScreen(s, 'SIZE=120x40', 15_000, (t) => /SIZE=120x40/.test(t))
    return `keyframe rows=${keyframeRows(k)}; ${t.match(/SIZE=120x40/)?.[0]}`
  })
}

/** Claude's or Codex's input box: up and empty enough to type into. */
async function enginePrompt(c: Client, s: Stream, engine: string) {
  return c.waitScreen(s, `${engine} prompt`, 60_000, (t) => {
    if (engine === 'claude' && /Try the new fullscreen renderer\?/.test(t)) { c.input(s, '2'); return false }
    // A profile whose Claude Code has not finished its first run: the text style, then the security notes (B4.15).
    if (engine === 'claude' && /Choose the text style|Press Enter to continue/.test(t)) { c.input(s, '\r'); return false }
    // Codex on Windows asks once how to sandbox its commands. The default needs an administrator; the run picks the
    // one that does not (written to config.toml's [windows], which the run's restore removes) (B4.15).
    if (engine === 'codex' && t.includes('Set up the Codex agent sandbox')) {
      if (/›\s*2\. Use non-admin sandbox/.test(t)) c.input(s, '\r')
      else c.input(s, '2')
      return false
    }
    if (engine === 'claude' && t.includes('Yes, I trust this folder')) {
      // The trust prompt's selection starts on "No, exit" in this build: move down, then Enter.
      if (/>\s*No, exit/.test(t)) c.input(s, '\u001b[B')
      else c.input(s, '\r')
      return false
    }
    return engine === 'claude' ? /\? for shortcuts|shift\+tab to cycle|accept edits|^\s*[>❯]\s/m.test(t) && !t.includes('trust this folder') && !t.includes('Enter to confirm')
        && !/Choose the text style|Press Enter to continue/.test(t)
      : /Ask Codex to do anything|›/.test(t) && !t.includes('Set up the Codex agent sandbox')
  })
}

async function engineChecks(c: Client, s: Stream, engine: string, label: string) {
  await attempt(`${label}: engine input box is up`, async () => tail(await enginePrompt(c, s, engine), 4).replace(/\n/g, ' | '))
  await attempt(`${label}: type a prompt, the engine answers`, async () => {
    const answers = (t: string) => (t.match(/^\s*[●•⏺]?\s*42\s*$/gm) ?? []).length
    const before = answers(await c.screen(s))
    await c.typeSlow(s, 'What is 6 times 7? Reply with only the number.', 6, 25)
    await sleep(700)
    c.input(s, '\r')
    const t = await c.waitScreen(s, 'answer 42', 120_000, (t) => answers(t) > before)
    return tail(t, 6).replace(/\n/g, ' | ')
  })
  await attempt(`${label}: paste 30 KB into the input box`, async () => {
    const { lines } = bigText()
    const t0 = Date.now()
    c.paste(s, lines.join('\n'))
    let last = ''
    const t = await c.waitScreen(s, 'paste indicator settles', 300_000, (t) => {
      const now = (t.match(/\[Pasted (text|Content)[^\]]*\]/gi) ?? []).join('')
      const settled = now && now === last
      last = now
      return !!settled
    })
    const what = (t.match(/\[Pasted (text|Content)[^\]]*\]/gi) ?? []).join('')
    const took = Date.now() - t0
    c.input(s, engine === 'claude' ? '\u001b\u001b' : '\u0003')
    await c.waitScreen(s, 'input cleared', 30_000, (t) => !/\[Pasted (text|Content)/i.test(t))
    return `${what} (settled after ~${took} ms)`
  })
  await attempt(`${label}: paste Vietnamese/CJK/Korean/emoji into the input box`, async () => {
    const before = await c.screen(s)
    const base = Object.fromEntries(UNICODE_PARTS.map((p) => [p, occurrences(before, p)]))
    c.paste(s, UNICODE)
    const t = await c.waitScreen(s, 'unicode in input', 20_000, (t) => UNICODE_PARTS.every((p) => occurrences(t, p) > base[p]))
    const line = t.split('\n').find((l) => l.includes('你好世界')) ?? ''
    c.input(s, engine === 'claude' ? '\u001b\u001b' : '\u0003')
    await sleep(1500)
    return line.trim()
  })
  await attempt(`${label}: resize 120x40 → 100x30 redraws at the new size`, async () => {
    const k = await c.resize(s, 100, 30)
    await sleep(2500)
    const t = await c.screen(s)
    const k2 = s.keyframes[s.keyframes.length - 1]
    const widest = Math.max(...t.split('\n').map((l) => [...l.replace(/\s+$/, '')].length))
    if (keyframeRows(k2) !== 30) throw new Error(`keyframe has ${keyframeRows(k2)} rows`)
    if (widest > 100) throw new Error(`a line is ${widest} wide`)
    return `keyframe rows=${keyframeRows(k)}/${keyframeRows(k2)}, widest line ${widest}`
  })
  await attempt(`${label}: resize back to 120x40`, async () => {
    const k = await c.resize(s, 120, 40)
    return `keyframe rows=${keyframeRows(k)}`
  })
}

export async function s1({ c, state, save, create }: Ctx) {
  const made: Record<string, string> = {}
  for (const engine of ['terminal', 'claude', 'codex']) {
    const t0 = Date.now()
    const a = await create(engine)
    if (!a) { check(`create ${engine}`, false, 'refused'); continue }
    const ready = await c.poll(`${engine} ready`, 90_000, async () => { const r = await c.row(a.id); return r?.launch?.state === 'ready' ? r : undefined }).catch((e) => { check(`create ${engine}`, false, e.message); return null })
    if (!ready) continue
    check(`create ${engine}`, true, `${a.id} pane ${ready.tmuxPane} ready in ${Date.now() - t0} ms`)
    made[engine] = a.id
  }
  state.s1 = made
  save()
  for (const [engine, id] of Object.entries(made)) {
    const s = await c.open(id, 120, 40)
    await sleep(1500)
    if (engine === 'terminal') await psChecks(c, s, 'PowerShell')
    else await engineChecks(c, s, engine, engine === 'claude' ? 'Claude Code' : 'Codex')
    log(`--- ${engine} final screen ---\n${tail(await c.screen(s), 14)}`)
    c.close(s)
  }
  summary()
}

/** Scenario 2: record the agents, restart the daemon (stop.cmd, then launch.ps1), check ids and streams. */
export async function s2before({ c, state, save, brief }: Ctx) {
  const agents = (await c.list(false)).filter((a) => a.status !== 'stopped').map(brief)
  state.s2 = { before: agents }
  save()
  for (const a of agents) log(JSON.stringify(a))
}

export async function s2after({ c, state, brief }: Ctx) {
  const before: any[] = state.s2.before
  const after = (await c.list(false)).filter((a) => a.status !== 'stopped').map(brief)
  for (const a of after) log(JSON.stringify(a))
  for (const b of before) {
    const a = after.find((x) => x.id === b.id)
    check(`${b.engine} ${b.id.slice(0, 8)} kept its id and pane`, !!a && a.pane === b.pane, a ? `pane ${b.pane} → ${a.pane}, status ${a.status}` : 'missing')
  }
  check('no new agents appeared', after.length === before.length, `${before.length} → ${after.length}`)
  for (const b of before) {
    await attempt(`${b.engine} ${b.id.slice(0, 8)} stream reattaches with its screen`, async () => {
      const s = await c.open(b.id, 120, 40)
      await sleep(1500)
      const t = await c.screen(s)
      if (b.engine === 'terminal') {
        c.input(s, "Write-Output ('AFTER_' + (40+2))\r")
        const t2 = await c.waitScreen(s, 'AFTER_42', 15_000, (t) => /^AFTER_42\s*$/m.test(t))
        c.close(s)
        return tail(t2, 2).replace(/\n/g, ' | ')
      }
      c.close(s)
      const mark = b.engine === 'claude' ? /Claude Code v/ : /OpenAI Codex/
      if (!mark.test(t)) throw new Error(`screen is not the engine's:\n${tail(t, 10)}`)
      const answer = t.split('\n').find((l) => /^\s*[●•⏺]\s*42\s*$/.test(l))?.trim()
      return `engine screen back${answer ? `, earlier answer still shown: ${answer}` : ''}: ${tail(t, 2).replace(/\n/g, ' | ')}`
    })
  }
  summary()
}

export async function shot({ c, args }: Ctx) {
  const s = await c.open(args[0], Number(args[1] ?? 120), Number(args[2] ?? 40))
  await sleep(1500)
  console.log(tail(await c.screen(s), 40))
  c.close(s)
}

export { results, check, attempt, summary, occurrences, keyframeRows, screenText, execFileSync }



export async function s1b({ c, args }: Ctx) {
  for (const [engine, id] of [['claude', args[0]], ['codex', args[1]]]) {
    if (!id) continue
    const s = await c.open(id, 120, 40)
    await sleep(1500)
    await engineChecks(c, s, engine, engine === 'claude' ? 'Claude Code' : 'Codex')
    log(`--- ${engine} final screen ---\n${tail(await c.screen(s), 14)}`)
    c.close(s)
  }
  summary()
}

export async function s1c({ c, create }: Ctx) {
  const a = await create('codex')
  await c.poll('codex ready', 90_000, async () => (await c.row(a.id))?.launch?.state === 'ready')
  const s = await c.open(a.id, 120, 40)
  await sleep(1500)
  await engineChecks(c, s, 'codex', 'Codex (fresh)')
  log(`--- final screen ---\n${tail(await c.screen(s), 14)}`)
  c.close(s)
  log(`agent ${a.id}`)
  summary()
}

export async function chars({ c, args }: Ctx) {
  const s = await c.open(args[0], 120, 40)
  await sleep(1500)
  c.input(s, '\u0003'); await sleep(1000)
  const probe = args[1] ?? 'q1?q2!q3/q4"q5:q6_q7'
  if (args[2] === 'paste') c.paste(s, probe); else c.input(s, probe)
  await sleep(2500)
  log(`sent ${JSON.stringify(probe)} as ${args[2] ?? 'input'}`)
  log(tail(await c.screen(s), 4))
  c.input(s, '\u0003'); await sleep(800)
  c.close(s)
}

export async function emoji({ c, create }: Ctx) {
  const a = await create('codex')
  await c.poll('codex ready', 90_000, async () => (await c.row(a.id))?.launch?.state === 'ready')
  const s = await c.open(a.id, 120, 40)
  await c.waitScreen(s, 'codex up', 60_000, (t) => /Ask Codex to do anything/.test(t))
  for (const [how, text] of [['paste', 'P1 🎉🚀 中文 Việt'], ['input', ' T1 🎉🚀 中文 Việt'], ['paste', ' P2 a🎉b'], ['input', ' T2 a🎉b']] as const) {
    if (how === 'paste') c.paste(s, text); else c.input(s, text)
    await sleep(2500)
    const line = (await c.screen(s)).split('\n').find((l) => l.includes('P1')) ?? ''
    log(`${how} ${JSON.stringify(text)} → composer: ${JSON.stringify(line.trim())}`)
  }
  c.input(s, '\u0003'); await sleep(800)
  c.close(s)
  log(`agent ${a.id}`)
}

export async function s1ps({ c, args }: Ctx) {
  const s = await c.open(args[0], 120, 40)
  await sleep(1500)
  await psChecks(c, s, 'PowerShell (rerun)')
  c.close(s)
  summary()
}

/** Ends Claude/Codex from inside their panes (Stop is refused on Windows without a bound conversation), then deletes
 *  every terminal row except those named in args. */
export async function tidy({ c, args }: Ctx) {
  const keep = new Set(args)
  for (const a of await c.list(false)) {
    if (keep.has(a.id) || a.status === 'stopped') continue
    if (a.engine === 'claude' || a.engine === 'codex') {
      const s = await c.open(a.id, 120, 40)
      await sleep(1000)
      if (a.engine === 'claude') { c.input(s, '\u001b'); await sleep(300); c.input(s, '/exit'); await sleep(500); c.input(s, '\r') }
      else { c.input(s, '\u0003'); await sleep(500); c.input(s, '\u0003'); await sleep(300); c.input(s, '\u0003') }
      await sleep(3000)
      c.close(s)
      log(`asked ${a.engine} ${a.id.slice(0, 8)} to exit`)
    }
  }
  await sleep(12_000)
  for (const a of await c.list(false)) {
    if (keep.has(a.id) || a.status === 'stopped' || a.engine !== 'terminal') continue
    const r = await c.rpc('agent_delete', { agentId: a.id }, 60_000)
    log(`delete terminal ${a.id.slice(0, 8)} → ${JSON.stringify(r).slice(0, 120)}`)
  }
  for (const a of await c.list(false)) log(`left: ${JSON.stringify({ id: a.id, engine: a.engine, status: a.status, pane: a.tmuxPane })}`)
}

export async function s4setup({ c, state, save, create }: Ctx) {
  const made: Record<string, string> = {}
  for (const engine of ['terminal', 'claude', 'codex']) {
    const a = await create(engine)
    await c.poll(`${engine} ready`, 90_000, async () => (await c.row(a.id))?.launch?.state === 'ready')
    made[engine] = a.id
  }
  await sleep(12_000)
  for (const [engine, id] of Object.entries(made)) {
    const r = await c.row(id)
    check(`${engine} ${id.slice(0, 8)} still ${engine} and active 12 s after create`, r?.engine === engine && r?.status !== 'stopped', `engine=${r?.engine} status=${r?.status} pane=${r?.tmuxPane}`)
  }
  state.s4 = made
  save()
  summary()
}

export async function s4after({ c, state }: Ctx) {
  const made: Record<string, string> = state.s4
  for (const [engine, id] of Object.entries(made)) {
    const r = await c.row(id)
    check(`${engine} ${id.slice(0, 8)} shows stopped after the host was killed`, r?.status === 'stopped', `status=${r?.status} pane=${r?.tmuxPane}`)
  }
  for (const [engine, id] of Object.entries(made)) {
    const t0 = Date.now()
    const r = await c.rpc('agent_resume', { agentId: id }, 120_000)
    check(`${engine} ${id.slice(0, 8)} resume`, !!r.agent && !r.error, `resumed=${r.resumed} pane=${r.agent?.tmuxPane} ${r.error ?? ''} (${Date.now() - t0} ms)`)
  }
  await sleep(15_000)
  for (const [engine, id] of Object.entries(made)) {
    await attempt(`${engine} ${id.slice(0, 8)} relaunched and stays ${engine} 15 s later`, async () => {
      const r = await c.row(id)
      if (r?.engine !== engine || r?.status === 'stopped') throw new Error(`engine=${r?.engine} status=${r?.status}`)
      const s = await c.open(id, 120, 40)
      await sleep(1500)
      const t = await c.screen(s)
      c.close(s)
      const mark = engine === 'claude' ? /Claude Code v/ : engine === 'codex' ? /OpenAI Codex/ : /PS [A-Z]:\\/
      if (!mark.test(t)) throw new Error(`screen:\n${tail(t, 8)}`)
      return `pane ${r.tmuxPane}: ${tail(t, 1)}`
    })
  }
  summary()
}

export async function s6snap({ c, state, save, args }: Ctx) {
  const rows = (await c.list(false)).filter((a) => a.status !== 'stopped')
  const snap = rows.map((a) => ({ id: a.id, engine: a.engine, pane: a.tmuxPane, status: a.status }))
  state.s6 = state.s6 ?? {}
  state.s6[args[0]] = snap
  save()
  log(`${args[0]}: ${rows.length} live rows; all rows ${(await c.list()).length}`)
  for (const r of snap) log(JSON.stringify(r))
  if (args[0] !== 'before') {
    const before: any[] = state.s6.before
    for (const b of before) {
      const a = snap.find((x) => x.id === b.id)
      check(`${args[0]}: ${b.engine} ${b.id.slice(0, 8)} same id, pane and engine`, !!a && a.pane === b.pane && a.engine === b.engine, a ? `${a.pane} ${a.engine} ${a.status}` : 'missing')
    }
    check(`${args[0]}: no new live rows`, snap.length === before.length, `${before.length} → ${snap.length}`)
    summary()
  }
}

const instanceOf = (a: any) => a?.terminal?.runtimes?.[0]?.instance ?? null
export async function s3list({ c }: Ctx) {
  for (const a of (await c.list(false)).filter((a) => a.status !== 'stopped')) log(JSON.stringify({ id: a.id, engine: a.engine, status: a.status, pane: a.tmuxPane, instance: instanceOf(a) }))
}

export async function s3check({ c, state, save, create }: Ctx) {
  const rows = (await c.list(false)).filter((a) => a.status !== 'stopped')
  for (const a of rows) log(JSON.stringify({ id: a.id, engine: a.engine, status: a.status, pane: a.tmuxPane, instance: instanceOf(a) }))
  const old = rows.filter((a) => instanceOf(a) === 'p2')
  check('the agents made on the p2 host are still listed, on instance p2', old.length >= 3, old.map((a) => `${a.engine}:${a.tmuxPane}`).join(', '))
  for (const a of old) {
    await attempt(`old ${a.engine} ${a.id.slice(0, 8)} (p2) still streams`, async () => {
      const s = await c.open(a.id, 120, 40)
      await sleep(1500)
      if (a.engine === 'terminal') {
        c.input(s, "Write-Output ('DRAIN_' + (40+2))\r")
        const t = await c.waitScreen(s, 'DRAIN_42', 15_000, (t) => /^DRAIN_42\s*$/m.test(t))
        c.close(s)
        return tail(t, 2).replace(/\n/g, ' | ')
      }
      const t = await c.screen(s)
      c.close(s)
      const mark = a.engine === 'claude' ? /Claude Code v/ : /OpenAI Codex/
      if (!mark.test(t)) throw new Error(tail(t, 6))
      return tail(t, 1)
    })
  }
  const fresh = await create('terminal')
  const row = await c.poll('new terminal ready', 30_000, async () => { const r = await c.row(fresh.id); return r?.launch?.state === 'ready' ? r : undefined })
  check('a new agent is made on the new host (p3)', instanceOf(row) === 'p3', `instance ${instanceOf(row)} pane ${row.tmuxPane}`)
  const s = await c.open(fresh.id, 120, 40)
  c.input(s, "Write-Output ('NEW_' + (40+2))\r")
  await attempt('the new p3 agent answers', async () => tail(await c.waitScreen(s, 'NEW_42', 20_000, (t) => /^NEW_42\s*$/m.test(t)), 2).replace(/\n/g, ' | '))
  c.close(s)
  state.s3 = { old: old.map((a) => a.id), fresh: fresh.id }
  save()
  summary()
}

export async function s7({ c, args }: Ctx) {
  const engines = args.length ? args : ['opencode', 'pi', 'commandcode', 'kilo', 'copilot', 'cursor', 'hermes', 'devin', 'muse', 'amp', 'grok', 'agy']
  for (const engine of engines) {
    const t0 = Date.now()
    const r = await c.rpc('agent_create', { engine, cwd: 'C:\\work\\e2e\\proj', bypassPermission: false }, 120_000)
    if (r.error) { log(`RESULT ${engine}: create refused ${r.error} — ${r.detail ?? ''}`); continue }
    const id = r.agent.id
    let row: any
    try {
      row = await c.poll(`${engine} ready`, 60_000, async () => { const x = await c.row(id); return x && x.launch?.state !== 'starting' ? x : undefined })
    } catch { row = await c.row(id) }
    await sleep(15_000)
    row = await c.row(id)
    let screen = ''
    try { const s = await c.open(id, 120, 40); await sleep(1500); screen = await c.screen(s); c.close(s) } catch (e) { screen = `(no stream: ${(e as Error).message})` }
    log(`RESULT ${engine}: id ${id.slice(0, 8)} launch=${row?.launch?.state} engine=${row?.engine} status=${row?.status} pane=${row?.tmuxPane} after ${Date.now() - t0} ms`)
    log(`--- ${engine} screen ---\n${tail(screen, 12)}`)
  }
}

export async function tuidefault({ c, create }: Ctx) {
  const a = await create('claude')
  await c.poll('claude ready', 90_000, async () => (await c.row(a.id))?.launch?.state === 'ready')
  const s = await c.open(a.id, 120, 40)
  await c.waitScreen(s, 'claude up', 60_000, (t) => /shift\+tab to cycle|\? for shortcuts/.test(t))
  await c.typeSlow(s, '/tui default', 4, 40)
  await sleep(1000)
  c.input(s, '\r')
  await sleep(4000)
  log(tail(await c.screen(s), 12))
  c.close(s)
  log(`agent ${a.id}`)
}

export async function perfcreate({ c, args, create }: Ctx) {
  for (let i = 0; i < Number(args[0]); i++) {
    const a = await create('terminal')
    await c.poll('ready', 30_000, async () => (await c.row(a.id))?.launch?.state === 'ready')
    console.log(`AGENT ${a.id}`)
  }
}

export async function perfstream({ c, args }: Ctx) {
  const s = await c.open(args[0], 120, 40)
  await sleep(1500)
  c.input(s, "while ($true) { Get-ChildItem -Recurse C:\\Windows -ErrorAction SilentlyContinue }\r")
  const t0 = Date.now()
  let bytes = 0, last = 0
  const until = t0 + Number(args[1] ?? 90) * 1000
  while (Date.now() < until) { await sleep(5000); bytes = s.output.length; log(`streamed ${bytes} chars so far (${Math.round((bytes - last) / 5)} chars/s)`); last = bytes }
  c.input(s, '\u0003')
  await sleep(1000)
  log(`STREAMED ${bytes} chars in ${Math.round((Date.now() - t0) / 1000)} s`)
  c.close(s)
}

/**
 * Phase B4: each engine's hook (or plugin) binds the conversation of a pane on the pty host, through HARNESS_PANE and the
 * hook credential. `run.cmd hooks [engine…]`. The default is the four spec section 6 names.
 */
export async function hooks({ c, args, create, waitReady }: Ctx) {
  const engines = args.length ? args : ['claude', 'codex', 'opencode', 'kilo']
  for (const engine of engines) {
    await attempt(`${engine}: its hook binds the pane's conversation`, async () => {
      const agent = await create(engine)
      if (!agent) throw new Error('create refused (see the line above)')
      await waitReady(agent.id)
      const s = await c.open(agent.id, 120, 40)
      if (engine === 'claude' || engine === 'codex') await enginePrompt(c, s, engine)
      else await sleep(15_000)
      // Claude and Codex bind at SessionStart; the plugins bind when their engine creates a session, at the first prompt.
      // Enter on its own: Kilo's input box took the text and the Enter of one write as text only (B4.15).
      c.input(s, 'Reply with the single word ok.')
      await sleep(1000)
      c.input(s, '\r')
      const row = await c.poll(`${engine} sessionId`, 120_000, async () => { const r = await c.row(agent.id); return r?.sessionId ? r : undefined })
      c.close(s)
      return `agent ${agent.id.slice(0, 8)} session ${row.sessionId} status ${row.status}`
    })
  }
  summary()
}
