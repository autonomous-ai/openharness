import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSwarmSkill, parseSwarmSkill, recordSwarmSkillNotice, refreshSwarmSkill } from './swarmSkills.js'
import { agentLaunchArgs } from './agentAttribution.js'
import { buildLaunchOverrides } from './launchOverrides.js'
import { gridLaunchInProcess } from '../testing/gridLaunchInProcess.js'

/** The Swarm's relaunch preparation, as the core hands it in while the Swarm is on (lib/launchOverrides.ts `swarm`). */
const SWARM = { prepare: prepareSwarmSkill, github: () => null }

const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'swarm-skills-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('built-in Swarm skills', () => {
  it.each(['claude', 'codex'] as const)('gives %s only its role skill in each session, preserving the shared project', engine => {
    const workspace = fixture(), data = fixture()
    writeFileSync(join(workspace, 'AGENTS.md'), 'Project rules\n')
    for (const role of ['lead', 'dev'] as const) {
      const skill = { role, key: `${engine}-${role}` }
      const prepared = prepareSwarmSkill(workspace, skill)
      expect(prepared.file.startsWith(join(realpathSync(workspace), '.harness', 'runtime'))).toBe(true)
      const text = readFileSync(prepared.file, 'utf8')
      expect(text).toContain(`name: swarm-${role}`)
      if (role === 'lead') expect(text).toContain('Route every new agent and every assignment')
      else {
        expect(text).toContain('Needs:')
        expect(text).toContain("Do not touch other groups' code.")
      }
      expect(text).not.toContain(`name: swarm-${role === 'lead' ? 'dev' : 'lead'}`)
      expect(readdirSync(dirname(dirname(prepared.file)))).toEqual([`swarm-${role}`])
      const args = agentLaunchArgs(engine, null, { cwd: workspace, read: () => null, swarmInstructions: prepared.instructions }, data)
      expect(args.join(' ')).toContain(prepared.file)
      expect(args.join(' ')).not.toContain('harness new')
    }
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe('Project rules\n')
    expect(readdirSync(workspace).sort()).toEqual(['.harness', 'AGENTS.md'])
    expect(readdirSync(data)).toEqual([])
  })

  // The owner's approved text (2026-10-22, with the Lead recovery guidance of 2026-10-23), byte for byte; the Lead's gains only the approved 2-hour line (2026-10-23).
  // The Builder's three push rules name its checkpoint push beside the review push (v1 liveness, 2026-10-26).
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  // The approved terminal line (spec/2026-10-23-lead-sees-agent-terminal.md), the Lead's alone, in both modes.
  const terminal = '- When a worker seems stuck, read its terminal; answer prompts within its task; ask the owner before approving anything risky.\n'
  // The approved overlap line (spec/2026-10-23-leads-see-and-talk.md, call 6), the Lead's alone, in both modes.
  const overlap = '- Before assigning, look at other projects\' active work; if your task touches the same code, say so in the Leads conversation and agree an order first.\n'
  // The Local models line (owner, 2026-10-23: the Lead considers Builders on local models; docs/plans/2026-10-23-swarm-local-models.md).
  const local = '- Local models: when the Swarm serves one (a member\'s model, a shared API, a model shared with a member), the route may pick it for low-difficulty, well-specified work; it costs no subscription. Set "local":true in the route only when a person asks for a local model. When a person names a model, set "model" to their words ("deepseek 4.1 flash"): the route then offers that model alone. Start the pick with the gridModel and gridName the route gives, never a model or effort.\n'
  const localDefault = '- Local models: the route may pick one for low-difficulty, well-specified work; set "local":true only when a person asks for one, set "model" to a model a person names, and start it with the route\'s gridModel and gridName.\n'
  // The approved mention line (spec/2026-10-24-lead-mentions.md, call 5), the Lead's alone, in both modes.
  const mention = '- When you need a person to act or decide, tag them in the message.\n'
  // The lost-work and checkpoint lines (Lead's brief for v1 liveness, 2026-10-26; docs: swarm-never-stops): the Lead's and
  // the Builder's alone, in both modes.
  const lost = '- When you are told a task is lost, hand it on at once: route it and assign it to another agent, avoiding what failed (another machine if its machine died, another account or engine if it hit a usage limit). The new brief tells the successor to continue from the lost attempt\'s pushed branch and last result, not to start over.\n'
  // The night-shift lines (v2 B, 2026-10-27): a task lost to a usage limit resumes by itself unless an account or engine
  // with allowance can take it now, and the morning digest. The Lead's alone, in both modes, right after the lost-work line.
  const limit = '- A task lost to a usage limit resumes by itself in the same session when the limit resets (its wake-up says when). Hand it on at once only to another account or engine with allowance now, with its pushed branch and last progress note.\n'
  const digest = '- Morning digest: when a person asks for one, set the project\'s digest to their local time and time zone ("project.digest" with time "08:00" and timeZone "Asia/Ho_Chi_Minh"). When it wakes you, check that each pull request under Shipped is merged, then post one message to the people in the project chat.\n'
  const checkpoint = '- Push your work branch at least every 30 minutes, and set your work status to working with a one-line note of what is done and what is next, so another agent can continue if you stop.\n'
  // The plan line (Lead's brief for v2 M, 2026-10-27; docs/plans/2026-10-27-swarm-scheduler.md): the Lead's alone, in both modes.
  const plan = '- With 3 or more groups waiting, run plan first: it places them all at once on the best machines and models. Then route each group in the plan\'s order and start the plan\'s pick, with overrideReason "scheduler plan" when the route picks otherwise. If plan cannot run here, route as usual.\n'
  // The decision lines (Lead's brief for v2 decisions, 2026-10-27): the Lead's and the Builder's alone, in both modes.
  const decision = '- Ask people for decisions in one place: decision.ask puts up to 10 questions to one person at once, each with 2 to 5 options, the one you recommend and what the answer unblocks. Keep working on your recommendation, marked provisional, until they answer: a notice in that conversation tells you, and harness super-tab decisions --answered shows the answer. A decision is not a private channel: anything private goes through Chat with PM.\n'
  const ask = '- When you know who decides, add ask to that needs-human (the person, 2 to 5 options, the one you recommend, what it unblocks) and keep working on your recommendation, marked provisional, until a notice says it was answered; read the answer with harness super-tab decisions --answered.\n'
  // The requests section (Lead's ruling for v2 G, the human leaderboard, 2026-10-27): the Lead's alone, in both modes, in a
  // section of its own so other groups' edits to the Lead text merge cleanly.
  const requests = '## Requests and Done\n- When you open a group for a person\'s request, asked in the project chat or in their Chat with PM, name them as its requester: requesterId on conversation.create, or conversation.requester for a group already open. It records only that they asked, never what they wrote.\n- Right after you merge a group\'s pull request, record it: conversation.merged with the group and the PR link, and mergedAt for a merge you record later. The leaderboard counts the request as shipped at the merge, even if its work is lost or cancelled afterwards. Mark a group Done only after its pull request has merged.\n\n'
  // Last in the Default Lead text, which has no red flags: after a blank line, ending the text.
  const requestsLast = `\n${requests.trimEnd()}\n`
  const twoHours = '- A Builder or Reviewer that has been down for 2 hours (machine offline, session gone or stopped): cancel its task with the reason, route it, and assign it to another agent with what the first one left (branch, last revision, last report).\n'
  it.each([
    ['lead', 'b9254e4bb5c633a73e1b87e6ca6690915e1c3a7bb55db0d3d093e6710dd719db'],
    ['dev', 'e78ce31a71f169d8956a2acd46e8bb43b79bd654b80b0fe3c33dbced9d2c3c75'],
    ['review', '424dc9db5642ed7093128525f30877ffc301eb6957b33e8234916de0f0eaa208'],
  ] as const)('writes the owner\'s Harness orchestration %s skill byte for byte', (role, sha256) => {
    expect(parseSwarmSkill({ role, key: 'session' })).toEqual({ role, key: 'session' })
    for (const mode of [undefined, 'orchestration'] as const) {
      const prepared = prepareSwarmSkill(fixture(), { role, key: 'session', ...(mode ? { mode } : {}) })
      expect(prepared.instructions).toBe(`Use the built-in swarm-${role} skill for this session. Before working, read ${JSON.stringify(prepared.file)} with your file or shell tool.`)
      const text = readFileSync(prepared.file, 'utf8')
      expect(text.startsWith(`---\nname: swarm-${role}\n`)).toBe(true)
      expect(text.split(twoHours)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(terminal)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(overlap)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(local)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(plan)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(mention)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(lost)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(checkpoint)).toHaveLength(role === 'dev' ? 2 : 1)
      expect(text.split(limit)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(digest)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(mention + decision)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(text.split(ask)).toHaveLength(role === 'dev' ? 2 : 1)
      expect(text.split(requests)).toHaveLength(role === 'lead' ? 2 : 1)
      expect(sha(text.replace(twoHours, '').replace(terminal, '').replace(overlap, '').replace(local, '').replace(mention, '').replace(lost, '').replace(checkpoint, '')
        .replace(limit, '').replace(digest, '').replace(decision, '').replace(ask, '').replace(requests, ''))).toBe(sha256)
    }
  })
  it('adds the 2-hour line to section 7 right after the 6-hour rule', () => {
    const text = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(text).toContain(`reassign work that has not moved for 6 hours; report on-screen trust, sign-in or permission questions in chat, naming the machine owner who can answer.\n${twoHours}`)
  })
  it('adds the terminal line where each Lead skill keeps work moving, right after the silent-worker rule', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`naming the machine owner who can answer.\n${twoHours}${lost}${limit}${digest}${terminal}- Keep each worker supplied`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`- A worker with active work that has said nothing for 20 minutes: ask it.\n${terminal}- A Builder or Reviewer`)
  })
  it('adds the overlap line last in each Lead skill\'s "Route, start, assign"', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`Never pass your chat history; put everything needed in the brief.\n${overlap}\n## 7. Run the work`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`- The brief is all a Builder gets; never rely on chat history.\n${overlap}\n## 4. Keep work moving`)
  })
  it('adds the plan line right after each Lead skill\'s first routing rule', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`- Route each group before starting or assigning: difficulty, risk, size, why, needs. Use the pick, or override with a reason.\n${plan}`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`- Route each group; reuse an idle agent before starting one; start only on the Swarm's machines.\n${plan}`)
  })
  it('adds the mention line right after each Lead skill\'s needs-a-person rule', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`- Needs-human: get the person's decision now.\n${mention}${decision}- Blocked: change something.`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`- Needs a person: get the decision now. Blocked: change something (context, model, size or plan); never resend the same thing.\n${mention}${decision}- Settle ambiguities`)
  })
  it('adds the decision lines right after the mention line for the Lead, and after the needs-human rule for the Builder', () => {
    for (const mode of ['orchestration', 'default'] as const) {
      const builder = readFileSync(prepareSwarmSkill(fixture(), { role: 'dev', key: 'session', mode }).file, 'utf8')
      expect(builder).toContain(`- A person's decision: mark needs-human with one short question.\n${ask}- Can't go on`)
    }
  })
  it('gives each Lead skill its requests section of its own: before the red flags, or last where there are none', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`\n\n${requests}## Red flags`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain.endsWith(`Call the roles Product Manager, Engineer and Reviewer.\n${requestsLast}`)).toBe(true)
  })
  it('adds the lost-work line right after each Lead skill\'s 2-hour rule', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`${twoHours}${lost}`)
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`assign it to another agent with what the first one left (branch, last revision, last report).\n${lost}${limit}${digest}- Work with no progress`)
  })
  it('adds the usage-limit and digest lines right after each Lead skill\'s lost-work line', () => {
    for (const mode of ['orchestration', 'default'] as const) {
      expect(readFileSync(prepareSwarmSkill(fixture(), { role: 'lead', key: 'session', mode }).file, 'utf8')).toContain(`${lost}${limit}${digest}`)
    }
  })
  it('adds the checkpoint line where each Builder skill keeps others able to resume its work', () => {
    const orchestration = readFileSync(prepareSwarmSkill(fixture(), { role: 'dev', key: 'session' }).file, 'utf8')
    expect(orchestration).toContain(`never redo a committed step.\n${checkpoint}`)
    // The orchestration Builder pushed only for review; its checkpoint push is now the other exception.
    expect(orchestration).toContain('No merge, PR or push, except pushing your own work branch: at least every 30 minutes, and when the group needs review.')
    expect(orchestration).not.toContain('only for review, only when the group needs it')
    const plain = readFileSync(prepareSwarmSkill(fixture(), { role: 'dev', key: 'session', mode: 'default' }).file, 'utf8')
    expect(plain).toContain(`- Have something to show at least every 20 minutes: a push or a short progress line.\n${checkpoint}`)
  })
  // The owner's approved Default texts (attached to the spec, 2026-10-23), byte for byte.
  it.each([
    ['lead', '8de53bf338b564fe1cec581a302280b778d1e62e788f8e310b36b5ad1d8f3309'],
    ['dev', '9294ae0dfe48a5c9185638ecb8f7cb2c2903253e5e823eb69592f3eb85455f12'],
    ['review', '56c1a9bfbe7cf2ff9ded4c83cebe9e801f8846250ec80849aa6afe41685db7d9'],
  ] as const)('writes the owner\'s Default %s skill byte for byte, with a prompt line that fits it', (role, sha256) => {
    expect(parseSwarmSkill({ role, key: 'session', mode: 'default' })).toEqual({ role, key: 'session', mode: 'default' })
    const prepared = prepareSwarmSkill(fixture(), { role, key: 'session', mode: 'default' })
    const text = readFileSync(prepared.file, 'utf8')
    expect(text.split(terminal)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(overlap)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(localDefault)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(plan)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(mention)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(lost)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(checkpoint)).toHaveLength(role === 'dev' ? 2 : 1)
    expect(text.split(limit)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(digest)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(mention + decision)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(text.split(ask)).toHaveLength(role === 'dev' ? 2 : 1)
    expect(text.split(requestsLast)).toHaveLength(role === 'lead' ? 2 : 1)
    expect(sha(text.replace(terminal, '').replace(overlap, '').replace(localDefault, '').replace(mention, '').replace(lost, '').replace(checkpoint, '')
      .replace(limit, '').replace(digest, '').replace(decision, '').replace(ask, '').replace(requestsLast, ''))).toBe(sha256)
    expect(prepared.instructions).toBe(`Use the swarm-${role} skill for this session: the team process; otherwise work your usual way. Before working, read ${JSON.stringify(prepared.file)} with your file or shell tool.`)
  })

  // Custom roles and skills per project (spec 2026-10-23, call 14): a custom role's text is installed as the skill of its
  // kind, under that kind's name, with the one front matter block Harness writes. Owners' texts may bring their own block.
  describe('a project on its Custom skills', () => {
    const skill = { role: 'lead' as const, key: 'custom' }
    const head = (name: string) => `---\nname: swarm-lead\ndescription: ${JSON.stringify(`The ${name} role of this project's Custom skills.`)}\n---\n`
    const shipped = () => readFileSync(prepareSwarmSkill(fixture(), { ...skill, mode: 'default' }).file, 'utf8')
    it.each([
      ['the shipped Default text', () => shipped(), () => shipped().replace(/^---\n[\s\S]*?\n---\n/, '')],
      ['a text with its own front matter', () => '---\nname: my-pm\ntitle: Ours\n---\n# Our way\nShip small.\n', () => '# Our way\nShip small.\n'],
      ['a text without front matter', () => '# Our way\n---\nShip small.\n', () => '# Our way\n---\nShip small.\n'],
    ])('installs %s under the kind\'s skill name with one front matter block', (_case, text, body) => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, { ...skill, mode: 'default' })
      expect(refreshSwarmSkill(workspace, skill, 'default', { name: 'Planner', text: text() })).toMatchObject({ file, owed: true })
      expect(file.endsWith(join('swarm', 'skills', 'swarm-lead', 'SKILL.md'))).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(head('Planner') + body())
    })
    it('tells the agent its role\'s text once, then each time the owner changes it, overwriting its own edits', () => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, { ...skill, mode: 'default' })
      const reread = `Before your next step, read ${JSON.stringify(file)} again with your file or shell tool and follow`
      const first = refreshSwarmSkill(workspace, skill, 'default', { name: 'Planner', text: 'Plan.\n' })!
      expect(first).toMatchObject({ owed: true, change: 1,
        notice: `This project now uses its Custom skills, as Planner. ${reread} it in place of your earlier swarm-lead skill.` })
      recordSwarmSkillNotice(workspace, skill, first)
      expect(refreshSwarmSkill(workspace, skill, 'default', { name: 'Planner', text: 'Plan.\n' })).toMatchObject({ owed: false, change: 1 })
      writeFileSync(file, 'edited')
      const edit = refreshSwarmSkill(workspace, skill, 'default', { name: 'Planner', text: 'Plan, then ship.\n' })!
      expect(edit).toMatchObject({ owed: true, change: 2,
        notice: `The project owner updated your Planner role. ${reread} the new version.` })
      expect(readFileSync(file, 'utf8')).toBe(head('Planner') + 'Plan, then ship.\n')
      recordSwarmSkillNotice(workspace, skill, edit)
      // Back to a built-in set: told as a switch, not as an update.
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: true, change: 3,
        notice: `This project now uses the Default skills. ${reread} it in place of your earlier swarm-lead skill.` })
      expect(readFileSync(file, 'utf8')).toBe(shipped())
    })
  })

  describe('a running session after a CLI update', () => {
    const skill = { role: 'dev' as const, key: 'running' }
    // What an older CLI left: its own text, and either no record (before records) or a record of that text.
    const older = (workspace: string, recorded: boolean) => {
      const { file } = prepareSwarmSkill(workspace, skill)
      const text = '---\nname: swarm-dev\n---\nAn older release of this skill.\n', version = createHash('sha256').update(text).digest('hex')
      writeFileSync(file, text)
      if (recorded) writeFileSync(join(dirname(file), 'version.json'), JSON.stringify({ text: version, notified: version }))
      else rmSync(join(dirname(file), 'version.json'))
      return file
    }
    it.each([false, true])('rewrites an older skill file and owes one notice until it is recorded (recorded before: %s)', recorded => {
      const workspace = fixture(), file = older(workspace, recorded)
      const sync = refreshSwarmSkill(workspace, skill, 'orchestration')!
      expect(sync).toMatchObject({ file, owed: true })
      expect(readFileSync(file, 'utf8')).toBe(readFileSync(prepareSwarmSkill(fixture(), skill).file, 'utf8'))
      // Not yet recorded: a later pass, or another daemon, still owes the same notice for the same text.
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toEqual(sync)
      recordSwarmSkillNotice(workspace, skill, sync)
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ file, owed: false })
      // The agent's own edits after the update are its own: the record says the file already holds this text.
      writeFileSync(file, 'edited')
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: false })
      expect(readFileSync(file, 'utf8')).toBe('edited')
    })
    it('owes nothing for a file already on the built-in text, new or from before records', () => {
      const fresh = fixture()
      prepareSwarmSkill(fresh, skill)
      expect(refreshSwarmSkill(fresh, skill, 'orchestration')).toMatchObject({ owed: false })
      const legacy = fixture(), { file } = prepareSwarmSkill(legacy, skill)
      rmSync(join(dirname(file), 'version.json'))
      expect(refreshSwarmSkill(legacy, skill, 'orchestration')).toMatchObject({ owed: false })
    })
    it('tells the agent what changed: a new release of its skill, in the words of its mode', () => {
      const workspace = fixture(), file = older(workspace, true)
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: true, change: 1,
        notice: `Harness updated your built-in swarm-dev skill. Before your next step, read ${JSON.stringify(file)} again with your file or shell tool and follow the new version.` })
      const other = fixture(), { file: mine } = prepareSwarmSkill(other, { ...skill, mode: 'default' })
      writeFileSync(mine, 'An older release of the Default skill.')
      writeFileSync(join(dirname(mine), 'version.json'), JSON.stringify({ text: 'older', notified: 'older', mode: 'default', told: 'default' }))
      expect(refreshSwarmSkill(other, skill, 'default')).toMatchObject({ owed: true,
        notice: `Harness updated your swarm-dev skill. Before your next step, read ${JSON.stringify(mine)} again with your file or shell tool and follow the new version.` })
    })
    it('moves a running session to the project\'s new mode, and owes a new notice each time, also when it switches back', () => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, { ...skill, mode: 'default' })
      const defaultText = readFileSync(file, 'utf8')
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: false })
      const toOrchestration = refreshSwarmSkill(workspace, skill, 'orchestration')!
      expect(toOrchestration).toMatchObject({ file, owed: true, change: 1,
        notice: `This project now uses the Harness orchestration skills. Before your next step, read ${JSON.stringify(file)} again with your file or shell tool and follow it in place of your earlier swarm-dev skill.` })
      expect(readFileSync(file, 'utf8')).toBe(readFileSync(prepareSwarmSkill(fixture(), skill).file, 'utf8'))
      recordSwarmSkillNotice(workspace, skill, toOrchestration)
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: false, change: 1 })
      const back = refreshSwarmSkill(workspace, skill, 'default')!
      expect(back).toMatchObject({ owed: true, change: 2,
        notice: `This project now uses the Default skills. Before your next step, read ${JSON.stringify(file)} again with your file or shell tool and follow it in place of your earlier swarm-dev skill.` })
      expect(readFileSync(file, 'utf8')).toBe(defaultText)
      // The same text as at launch, but a new change: its notice is not the launch's (there was none) nor a retry of another.
      recordSwarmSkillNotice(workspace, skill, back)
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: false, change: 2 })
      // A relaunch keeps the file and says what it holds, whatever mode the session was first started in.
      refreshSwarmSkill(workspace, skill, 'orchestration')
      expect(prepareSwarmSkill(workspace, { ...skill, mode: 'default' }).instructions)
        .toBe(`Use the built-in swarm-dev skill for this session. Before working, read ${JSON.stringify(file)} with your file or shell tool.`)
    })
    it('puts back the mode\'s text when a switch was cut off after its file and before its record', () => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, { ...skill, mode: 'default' })
      const defaultText = readFileSync(file, 'utf8'), record = join(dirname(file), 'version.json'), before = readFileSync(record, 'utf8')
      refreshSwarmSkill(workspace, skill, 'orchestration')
      // The pass stopped after replacing SKILL.md: the record still says Default, the file holds orchestration.
      writeFileSync(record, before)
      expect(readFileSync(file, 'utf8')).not.toBe(defaultText)
      // The project switched back before the retry: the file is Default again, and the agent, never told, owes nothing.
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: false })
      expect(readFileSync(file, 'utf8')).toBe(defaultText)
      // The same retry without a switch back finishes the switch and owes its notice.
      refreshSwarmSkill(workspace, skill, 'orchestration'); writeFileSync(record, before)
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: true,
        notice: expect.stringMatching(/^This project now uses the Harness orchestration skills\./) })
    })
    it('tells the agent again when it switches back after a notice that was sent but never recorded', () => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, { ...skill, mode: 'default' })
      // Sent, then the daemon stopped before recordSwarmSkillNotice: the agent may be following the orchestration text.
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: true, change: 1 })
      const back = refreshSwarmSkill(workspace, skill, 'default')!
      expect(back).toMatchObject({ owed: true, change: 2,
        notice: `This project now uses the Default skills. Before your next step, read ${JSON.stringify(file)} again with your file or shell tool and follow it in place of your earlier swarm-dev skill.` })
      // Recording an earlier rewrite's notice does not cover this one.
      recordSwarmSkillNotice(workspace, skill, { version: 'any', change: 1 })
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: true, change: 2 })
      recordSwarmSkillNotice(workspace, skill, back)
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: false, change: 2 })
    })
    it('tells an agent with a record from before modes again when it switches back after an unrecorded notice', () => {
      const workspace = fixture(), { file } = prepareSwarmSkill(workspace, skill), text = readFileSync(file, 'utf8')
      // What #1585 left: the orchestration text, told, with no rewrite count.
      writeFileSync(join(dirname(file), 'version.json'), JSON.stringify({ text: sha(text), notified: sha(text) }))
      // Switched to Default and its notice sent, then the daemon stopped before recording it.
      expect(refreshSwarmSkill(workspace, skill, 'default')).toMatchObject({ owed: true })
      expect(refreshSwarmSkill(workspace, skill, 'orchestration')).toMatchObject({ owed: true,
        notice: expect.stringMatching(/^This project now uses the Harness orchestration skills\./) })
      expect(readFileSync(file, 'utf8')).toBe(text)
    })
    it('does nothing for a session whose skill was never prepared in this workspace', () => {
      expect(refreshSwarmSkill(fixture(), skill, 'orchestration')).toBeNull()
      expect(refreshSwarmSkill(join(fixture(), 'removed-worktree'), skill, 'orchestration')).toBeNull()
    })
    it('never writes through a redirected skill file', () => {
      const workspace = fixture(), file = older(workspace, false), target = join(fixture(), 'elsewhere.md')
      writeFileSync(target, 'kept')
      rmSync(file); symlinkSync(target, file)
      expect(() => refreshSwarmSkill(workspace, skill, 'orchestration')).toThrow('plain file')
      expect(readFileSync(target, 'utf8')).toBe('kept')
    })
  })

  it('keeps standalone session skills out of Git, including git add -A', () => {
    const workspace = fixture()
    execFileSync('git', ['init', '-q', workspace])
    prepareSwarmSkill(workspace, { role: 'dev', key: 'standalone' })
    execFileSync('git', ['add', '-A'], { cwd: workspace })
    const staged = execFileSync('git', ['ls-files'], { cwd: workspace, encoding: 'utf8' })
    expect(staged).not.toContain('SKILL.md')
    expect(staged.trim()).toBe('.harness/.gitignore')
  })

  it('preserves custom ignore rules and adds the Store runtime rules only once', () => {
    const workspace = fixture(), saved = { role: 'lead' as const, key: 'one' }
    mkdirSync(join(workspace, '.harness'))
    const file = join(workspace, '.harness', '.gitignore')
    writeFileSync(file, '# Mine\nprivate-data')
    prepareSwarmSkill(workspace, saved)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n')
    prepareSwarmSkill(workspace, saved)
    expect(readFileSync(file, 'utf8')).toBe('# Mine\nprivate-data\nruntime/\nlegacy-AGENTS.md\n')
  })

  it('refuses a redirected runtime ignore file without modifying its target', () => {
    const workspace = fixture(), target = join(fixture(), 'rules')
    mkdirSync(join(workspace, '.harness'))
    writeFileSync(target, 'Keep these rules')
    symlinkSync(target, join(workspace, '.harness', '.gitignore'))
    expect(() => prepareSwarmSkill(workspace, { role: 'dev', key: 'one' })).toThrow(/symlink|plain/i)
    expect(readFileSync(target, 'utf8')).toBe('Keep these rules')
  })

  it('keeps the session skill bytes on retry and isolates a different session', () => {
    const workspace = fixture(), saved = { role: 'lead' as const, key: 'first' }
    const first = prepareSwarmSkill(workspace, saved)
    writeFileSync(first.file, 'saved session instructions')
    expect(prepareSwarmSkill(workspace, saved)).toEqual(first)
    expect(readFileSync(first.file, 'utf8')).toBe('saved session instructions')
    const next = prepareSwarmSkill(workspace, { role: 'lead', key: 'second' })
    expect(next.file).not.toBe(first.file)
    expect(readFileSync(next.file, 'utf8')).toContain('name: swarm-lead')
  })

  it.each(['.harness', 'runtime', 'skill', 'file'])('refuses a redirected managed %s without writing through it', part => {
    const workspace = fixture(), outside = fixture(), saved = { role: 'dev' as const, key: 'one' }
    const first = prepareSwarmSkill(workspace, saved)
    const path = part === '.harness' ? join(workspace, '.harness') : part === 'runtime' ? join(workspace, '.harness', 'runtime') : part === 'skill' ? dirname(first.file) : first.file
    rmSync(path, { recursive: true, force: true })
    symlinkSync(outside, path)
    expect(() => prepareSwarmSkill(workspace, saved)).toThrow(/plain|symlink/i)
    expect(readdirSync(outside)).toEqual([])
  })

  it('validates persisted role metadata and refuses an empty key', () => {
    for (const value of [null, undefined, {}, { role: 'builder', key: 'x' }, { role: 'dev', key: '' }, { role: 'lead', key: 7 }]) expect(parseSwarmSkill(value)).toBeUndefined()
    expect(parseSwarmSkill({ role: 'dev', key: 'x' })).toEqual({ role: 'dev', key: 'x' })
    // An unknown mode is dropped, not refused: the session keeps its role and launches as before modes.
    expect(parseSwarmSkill({ role: 'dev', key: 'x', mode: 'light' })).toEqual({ role: 'dev', key: 'x' })
    expect(parseSwarmSkill({ role: 'dev', key: 'x', mode: 'orchestration' })).toEqual({ role: 'dev', key: 'x', mode: 'orchestration' })
    // The Harness GitHub App's flag is kept for relaunches, and only as true.
    expect(parseSwarmSkill({ role: 'dev', key: 'x', github: true })).toEqual({ role: 'dev', key: 'x', github: true })
    expect(parseSwarmSkill({ role: 'dev', key: 'x', github: 'yes' })).toEqual({ role: 'dev', key: 'x' })
    expect(() => prepareSwarmSkill(fixture(), { role: 'lead', key: '' })).toThrow()
  })

  it.each(['claude', 'codex'] as const)('restores %s skill on relaunch without overwriting the saved content', async engine => {
    const cwd = fixture(), swarmSkill = { role: 'dev' as const, key: 'original' }
    const first = prepareSwarmSkill(cwd, swarmSkill)
    const result = await buildLaunchOverrides({ capabilities: async () => ({ sessionEnv: true }), installCodexHooks: () => true, machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(),
      writeGridConfigDir: async () => '/unused', readCodexConfig: () => null, readAttribution: () => null, swarm: SWARM }, engine, { cwd, swarmSkill }, 'new-registry-id')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.overrides?.extraArgs.join(' ')).toContain(first.file)
    expect(readdirSync(join(cwd, '.harness', 'runtime'))).toHaveLength(1)
  })

  it('refuses relaunch with a missing workspace or a redirected runtime', async () => {
    const cwd = fixture(), swarmSkill = { role: 'dev' as const, key: 'original' }
    symlinkSync(fixture(), join(cwd, '.harness'))
    const deps = { capabilities: async () => ({ sessionEnv: true }), installCodexHooks: () => true, machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(), writeGridConfigDir: async () => '/unused', swarm: SWARM }
    expect(await buildLaunchOverrides(deps, 'claude', { swarmSkill }, 'a')).toMatchObject({ ok: false, error: 'SWARM_SKILL_FAILED', detail: expect.stringContaining('no saved workspace') })
    expect(await buildLaunchOverrides(deps, 'claude', { cwd, swarmSkill }, 'a')).toMatchObject({ ok: false, error: 'SWARM_SKILL_FAILED', detail: expect.not.stringContaining('HARNESS_SWARM') })
  })
})
