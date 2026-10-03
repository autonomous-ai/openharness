import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import {
  CreateTeam, Evidence, Exchange, MemberSpec, OperationId, QuestionSpec, Receipt, Team,
  TEAM_PROTOCOL, TeamError, requireTeam, isTerminalReceipt,
  type Actor, type Address, type Consultation, type Delivery, type DeliveryAction, type Member, type MemberRuntime,
} from './model.js'
import { answerPrompt, consultPrompt, introduction, memberCommand, questionPrompt } from './prompts.js'
import { TeamStore } from './store.js'

export interface TeamDependencies {
  stateDir: string
  machineId: string
  /** Executable on the member's machine, ending in `team`. Shell-quoted by the host. */
  command(address: Address): string
  runtime(address: Address): Promise<MemberRuntime | null>
  taskScope?(address: Address): Promise<string | null>
  questionReplied?(address: Address, teamId: string, questionId: string): Promise<void>
  delivery(address: Address, action: DeliveryAction, delivery: Delivery | { id: string }): Promise<Receipt | null>
  changed?(id: string, revision: number): void
  now?(): number
}

const id = (): string => randomBytes(16).toString('hex')
const freshReceipt = (deliveryId: string, now: number): Receipt => ({ id: deliveryId, state: 'pending', updatedAt: now })
const serial = (value: unknown): string => JSON.stringify(value)
const creationHash = (value: unknown): string => createHash('sha256').update(serial(value)).digest('hex')
type NoticeKind = 'intro' | 'question' | 'answer' | 'consult'
export const channelTeamId = (tabId: string): string => createHash('sha256').update(`harness-channel-v1:${tabId}`).digest('hex').slice(0, 32)

/** A team is a set of continuing peers, not an orchestrator run or a view's lifetime. */
export class TeamService {
  private readonly store: TeamStore<Team>
  private readonly teams = new Map<string, Team>()
  private readonly creating = new Map<string, { fingerprint: string; promise: Promise<Record<string, unknown>> }>()
  private readonly flights = new Set<string>()
  private readonly faults = new Map<string, string>()
  private loaded = false
  private stopped = false
  private channelsEnabled = false
  private timer: ReturnType<typeof setInterval> | null = null
  private pumping: Promise<void> | null = null
  constructor(private readonly deps: TeamDependencies) { this.store = new TeamStore(deps.stateDir, Team) }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  start(): void {
    if (this.loaded) return
    for (const teamId of this.store.ids()) {
      try {
        const team = this.store.read(teamId)!
        requireTeam(team.id === teamId && team.machineId === this.deps.machineId, 'CORRUPT_STATE', 'Team ownership does not match its record.')
        this.teams.set(teamId, team)
      } catch { this.faults.set(teamId, 'Team state could not be read; its file is preserved.') }
    }
    this.loaded = true
    this.timer = setInterval(() => { void this.pump().catch(() => { /* persisted state remains authoritative */ }) }, 2000)
    this.timer.unref?.()
  }
  private get(teamId: string): Team {
    OperationId.parse(teamId)
    this.start()
    requireTeam(!this.faults.has(teamId), 'CORRUPT_STATE', this.faults.get(teamId) ?? '')
    const team = this.teams.get(teamId)
    requireTeam(team, 'TEAM_NOT_FOUND', 'This team is not available on this machine.')
    return structuredClone(team)
  }
  private commit(team: Team): void {
    team.updatedAt = this.now()
    team.revision++
    this.store.write(team.id, team)
    this.teams.set(team.id, structuredClone(team))
    this.deps.changed?.(team.id, team.revision)
  }
  private member(team: Team, actor: Actor, requested?: string, allowDeparted = false): Member | null {
    if (actor.kind === 'owner') {
      if (!requested) return null
      const member = team.members.find(m => m.id === requested)
      requireTeam(member, 'MEMBER_NOT_FOUND', 'That teammate is no longer in this team.')
      return member
    }
    requireTeam(/^[a-f0-9]{64}$/.test(actor.key), 'NOT_A_MEMBER', 'Invalid team membership.')
    const member = team.members.find(m => timingSafeEqual(Buffer.from(m.key), Buffer.from(actor.key)))
    requireTeam(member && (member.enabled || (allowDeparted && team.channel)), 'NOT_A_MEMBER', 'This membership is unavailable or was removed by the user.')
    requireTeam(!requested || member.id === requested, 'WRONG_MEMBER', 'A member can only act as itself.')
    return member
  }
  private owner(actor: Actor): void { requireTeam(actor.kind === 'owner', 'OWNER_REQUIRED', 'Only the user can manage a team.') }
  setChannelsEnabled(enabled: boolean): void {
    if (this.channelsEnabled === enabled) return
    this.channelsEnabled = enabled
    this.suppressed.clear()
  }
  private effectiveState(team: Team): Team['state'] {
    if (team.channel && !this.channelsEnabled && team.state === 'active') return 'paused'
    return team.state
  }
  private active(team: Team): void {
    requireTeam(!team.channel || this.channelsEnabled, 'CHANNELS_DISABLED', 'Enable Swarm collaboration in Settings → Experimental first.')
    requireTeam(this.effectiveState(team) === 'active', 'TEAM_PAUSED', 'Team communication is paused or archived.')
  }
  isChannel(teamId: string): boolean { const team = this.get(teamId); return !!team.channel }
  /** Discovery and new questions must use the accepted prompt's origin. Replies/status remain
   * attached to their existing exchange, including after the user moves a pane. */
  async authorizeTask(teamId: string, actor: Actor, action: string): Promise<void> {
    const team = this.get(teamId)
    if (!team.channel || actor.kind === 'owner' || !this.deps.taskScope
      || !['get', 'members', 'ask', 'inbox'].includes(action)) return
    const member = this.member(team, actor)!
    const scope = await this.deps.taskScope(member)
    requireTeam(scope === teamId, 'CHANNEL_SCOPE',
      `Use the swarm of the current task. Resolve it with: ${this.deps.command(member)} --machine ${member.machineId} context --agent ${member.agentId}. If its origin is unavailable, continue independently; do not choose another swarm.`)
  }
  context(teamId: string, address: Address): Record<string, unknown> {
    const team = this.get(teamId)
    this.active(team)
    const member = team.members.find(m => m.enabled && m.machineId === address.machineId && m.agentId === address.agentId)
    requireTeam(team.channel && member, 'CHANNEL_SCOPE', 'This harness is no longer a member of the task’s swarm.')
    return { teamId, tabId: team.channel.tabId, name: team.name, command: memberCommand(team, member, this.deps.command(member)) }
  }
  async questionReplied(teamId: string, questionId: string, actor: Actor): Promise<void> {
    const team = this.get(teamId)
    if (team.channel && actor.kind === 'member') {
      const member = this.member(team, actor, undefined, true)!
      await this.deps.questionReplied?.(member, teamId, questionId)
    }
  }
  private project(team: Team): Record<string, unknown> {
    const { creationHash: _creationHash, ...publicTeam } = team
    return { ...publicTeam, members: team.members.map(({ key: _key, ...member }) => member) }
  }
  list(actor: Actor): Record<string, unknown> {
    this.owner(actor)
    this.start()
    return {
      protocol: TEAM_PROTOCOL,
      teams: [...this.teams.values()].map(t => ({ id: t.id, machineId: t.machineId, name: t.name, description: t.description,
        state: t.state, revision: t.revision, members: t.members.filter(m => m.enabled).length,
        pending: t.exchanges.filter(e => e.state === 'pending').length, updatedAt: t.updatedAt, ...(t.channel ? { channel: t.channel } : {}) })),
      errors: [...this.faults].map(([teamId, detail]) => ({ id: teamId, error: 'CORRUPT_STATE', detail })),
    }
  }
  async snapshot(teamId: string, actor: Actor): Promise<Record<string, unknown>> {
    this.expire(teamId)
    const team = this.get(teamId)
    this.member(team, actor)
    const members = await Promise.all(team.members.map(async ({ key: _key, ...member }) => ({ ...member,
      runtime: member.enabled ? await this.deps.runtime(member).catch(() => null) : null,
    })))
    return { ...this.project(team), members }
  }
  create(raw: unknown, actor: Actor): Promise<Record<string, unknown>> {
    this.owner(actor)
    const input = CreateTeam.parse(raw)
    this.start()
    const fingerprint = serial(input)
    const pending = this.creating.get(input.id)
    if (pending) {
      requireTeam(pending.fingerprint === fingerprint, 'ID_CONFLICT', 'That team ID already names another creation request.')
      return pending.promise
    }
    const promise = this.createNow(input, actor).finally(() => this.creating.delete(input.id))
    this.creating.set(input.id, { fingerprint, promise })
    return promise
  }
  private async createNow(input: z.infer<typeof CreateTeam>, actor: Actor): Promise<Record<string, unknown>> {
    requireTeam(!this.faults.has(input.id), 'CORRUPT_STATE', 'This team ID has a preserved unreadable record.')
    const existing = this.teams.get(input.id)
    if (existing) {
      requireTeam(existing.creationHash === creationHash(input), 'ID_CONFLICT', 'That team ID already names different work.')
      return this.snapshot(input.id, actor)
    }
    requireTeam(this.teams.size < 100, 'TEAM_LIMIT', 'This machine has reached its retained team limit.')
    this.validateMembers(input.members)
    const runtimes = await Promise.all(input.members.map(m => this.deps.runtime(m)))
    requireTeam(runtimes.every(r => r && r.engine !== 'terminal'), 'AGENT_UNAVAILABLE', 'Every member must be an existing agent on a reachable, paired machine.')
    requireTeam(!this.stopped, 'STOPPED', 'The daemon is shutting down.')
    const now = this.now()
    const team: Team = { ...input, creationHash: creationHash(input), protocol: TEAM_PROTOCOL, machineId: this.deps.machineId, state: 'active', revision: 1,
      createdAt: now, updatedAt: now, exchanges: [], consultations: [],
      members: input.members.map(m => {
        const memberId = id()
        return { ...m, id: memberId, key: randomBytes(32).toString('hex'), enabled: true, joinedAt: now,
          introduction: freshReceipt(`team:${input.id}:${memberId}:intro`, now) }
      }),
    }
    this.store.write(team.id, team)
    this.teams.set(team.id, team)
    this.deps.changed?.(team.id, team.revision)
    return this.snapshot(team.id, actor)
  }

  /** Only the authenticated desk synchronizer calls this. Layout owns membership;
   * old capabilities can finish their own exchanges but cannot start new work. */
  async syncChannel(input: { tabId: string; name: string; revision: number; members: Address[]; closed?: boolean }): Promise<void> {
    if (!this.channelsEnabled) return
    const teamId = channelTeamId(input.tabId)
    this.start()
    requireTeam(!this.faults.has(teamId), 'CORRUPT_STATE', 'The channel ledger could not be read; its file is preserved.')
    const before = this.teams.get(teamId)
    if (before?.channel && before.channel.deskRevision > input.revision) return
    const distinct = [...new Map(input.members.map(m => [`${m.machineId}/${m.agentId}`, m])).values()]
    requireTeam(distinct.length <= 32, 'CHANNEL_FULL', 'A channel supports at most 32 agents.')
    const runtimes = await Promise.all(distinct.map(m => this.deps.runtime(m).catch(() => null)))
    if (this.stopped || !this.channelsEnabled) return
    const current = this.teams.get(teamId)
    if (current?.channel && current.channel.deskRevision > input.revision) return
    const now = this.now()
    const team: Team = current ? structuredClone(current) : {
      protocol: TEAM_PROTOCOL, id: teamId, machineId: this.deps.machineId,
      creationHash: creationHash({ channel: input.tabId }), name: input.name,
      description: 'Agents in this swarm collaborate here. Membership follows its harnesses.',
      state: 'active', revision: 1, createdAt: now, updatedAt: now,
      members: [], exchanges: [], consultations: [],
    }
    if (!current) requireTeam(this.teams.size < 100, 'TEAM_LIMIT', 'This machine has reached its retained channel limit.')
    team.channel = { tabId: input.tabId, deskRevision: input.revision, closed: !!input.closed }
    team.name = input.name
    const wanted = new Set(distinct.filter((_, i) => runtimes[i]?.engine !== 'terminal').map(m => `${m.machineId}/${m.agentId}`))
    for (const member of team.members) {
      if (member.enabled && (input.closed || !wanted.has(`${member.machineId}/${member.agentId}`))) member.enabled = false
    }
    if (!input.closed) for (const [index, address] of distinct.entries()) {
      const runtime = runtimes[index]
      if (runtime?.engine === 'terminal') continue
      let member = team.members.find(m => m.enabled && m.machineId === address.machineId && m.agentId === address.agentId)
      // An unresolved new address stays in the desk, not in an engine inbox.
      // It joins once discovery confirms that it is an agent (including offline agents).
      if (!member && !runtime) continue
      if (!member) {
        requireTeam(team.members.length < 512, 'CHANNEL_FULL', 'This channel has reached its retained membership limit.')
        const memberId = id()
        const suffix = creationHash(address).slice(0, 12)
        const stem = (runtime!.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 24) || 'agent')
        member = { ...address, id: memberId, name: `${stem}-${suffix}`, role: '', enabled: true,
          key: randomBytes(32).toString('hex'), joinedAt: now, introduction: freshReceipt(`team:${teamId}:${memberId}:intro`, now) }
        team.members.push(member)
      }
      if (runtime) member.role = [runtime.name, runtime.engine, runtime.cwd, runtime.branch && `branch ${runtime.branch}`].filter(Boolean).join(' · ').slice(0, 600)
    }
    if (team.members.filter(m => m.enabled).length > 1) {
      for (const member of team.members) if (member.enabled && member.introductionExpiresAt === undefined) member.introductionExpiresAt = now + 86_400_000
    }
    if (!current || serial(team) !== serial(current)) this.commit(team)
  }

  closeMissingChannels(tabIds: Set<string>, revision: number): void {
    this.start()
    for (const prior of this.teams.values()) {
      if (!prior.channel || tabIds.has(prior.channel.tabId) || prior.channel.deskRevision > revision || prior.channel.closed) continue
      const team = structuredClone(prior)
      team.channel = { ...team.channel!, deskRevision: revision, closed: true }
      for (const member of team.members) member.enabled = false
      this.commit(team)
    }
  }

  consult(teamId: string, operationId: string, address: Address, actor: Actor): Consultation {
    this.owner(actor)
    OperationId.parse(operationId)
    const team = this.get(teamId)
    requireTeam(team.channel, 'CHANNEL_REQUIRED', 'Consult uses the focused harness’s tab channel.')
    const prior = team.consultations.find(c => c.id === operationId)
    if (prior) {
      const member = team.members.find(m => m.id === prior.memberId)
      requireTeam(member?.machineId === address.machineId && member.agentId === address.agentId, 'ID_CONFLICT', 'That instruction already belongs to another agent or scope.')
      return structuredClone(prior)
    }
    this.active(team)
    const member = team.members.find(m => m.enabled && m.machineId === address.machineId && m.agentId === address.agentId)
    requireTeam(member, 'NOT_A_MEMBER', 'The focused harness is no longer in this swarm.')
    requireTeam(team.members.some(m => m.enabled && m.id !== member.id), 'NO_PEERS', 'Add another harness to this swarm to consult a peer.')
    requireTeam(team.consultations.length < 500, 'CHANNEL_FULL', 'This channel has reached its retained instruction limit.')
    const pending = team.consultations.find(c => c.memberId === member.id && ['pending', 'queued', 'submitted', 'delivered', 'unknown'].includes(c.receipt.state))
    if (pending) return structuredClone(pending)
    const consultation: Consultation = { id: operationId, memberId: member.id, createdAt: this.now(),
      receipt: freshReceipt(`team:${team.id}:${operationId}:consult`, this.now()) }
    team.consultations.push(consultation)
    this.commit(team)
    if (['pending', 'queued'].includes(member.introduction.state)) void this.cancelIntroduction(teamId, member.id)
    return structuredClone(consultation)
  }
  private validateMembers(members: z.infer<typeof MemberSpec>[]): void {
    requireTeam(new Set(members.map(m => m.name.toLowerCase())).size === members.length, 'DUPLICATE_NAME', 'Give each teammate a unique name.')
    requireTeam(new Set(members.map(m => `${m.machineId}/${m.agentId}`)).size === members.length, 'DUPLICATE_MEMBER', 'A harness can only appear once in a team.')
  }
  ask(teamId: string, raw: unknown, actor: Actor): Exchange {
    this.expire(teamId)
    const team = this.get(teamId)
    const input = QuestionSpec.parse(raw)
    this.member(team, actor, input.from)
    const to = team.members.find(m => m.id === input.to)
      ?? team.members.find(m => m.enabled && m.name.toLowerCase() === input.to.replace(/^@/, '').toLowerCase())
    requireTeam(to, 'MEMBER_NOT_FOUND', 'No teammate has that name. Read members to choose the exact teammate.')
    const spec = { ...input, to: to.id }
    const existing = team.exchanges.find(e => e.id === spec.id)
    if (existing) {
      requireTeam(serial(QuestionSpec.parse(existing)) === serial(spec) && existing.origin === (actor.kind === 'owner' ? 'owner' : 'agent'),
        'ID_CONFLICT', 'That question ID already refers to different content.')
      return existing
    }
    this.active(team)
    requireTeam(to.enabled && team.members.find(m => m.id === input.from)?.enabled, 'MEMBER_REMOVED', 'Both teammates must still be connected.')
    requireTeam(input.from !== to.id, 'SELF_MESSAGE', 'Choose another teammate.')
    requireTeam(team.exchanges.length < 500, 'TEAM_FULL', 'This team history is full. Archive it and create another team.')
    requireTeam(team.exchanges.filter(e => e.state === 'pending' && e.from === input.from).length < 8, 'TOO_MANY_QUESTIONS', 'This teammate already has eight unanswered questions.')
    requireTeam(team.exchanges.filter(e => e.createdAt > this.now() - 60_000).length < 30, 'RATE_LIMIT', 'The team has reached 30 questions in a minute. Continue existing work first.')
    if (spec.parentId) {
      let parent = team.exchanges.find(e => e.id === spec.parentId), depth = 1
      requireTeam(parent && (parent.from === input.from || parent.to === input.from), 'INVALID_PARENT', 'A follow-up must refer to a question involving you.')
      while (parent?.parentId) { parent = team.exchanges.find(e => e.id === parent!.parentId); depth++ }
      requireTeam(depth < 4, 'CHAIN_LIMIT', 'This exchange has reached its follow-up limit. Bring the unresolved decision to the user.')
    }
    const now = this.now()
    const exchange: Exchange = { ...spec, origin: actor.kind === 'owner' ? 'owner' : 'agent', state: 'pending', createdAt: now, expiresAt: now + input.ttlMs,
      delivery: freshReceipt(`team:${team.id}:${spec.id}:question`, now) }
    team.exchanges.push(exchange)
    this.commit(team)
    return structuredClone(exchange)
  }
  reply(teamId: string, questionId: string, text: unknown, evidence: unknown, actor: Actor, memberId?: string): Exchange {
    this.expire(teamId)
    const team = this.get(teamId)
    const exchange = team.exchanges.find(e => e.id === OperationId.parse(questionId))
    requireTeam(exchange, 'QUESTION_NOT_FOUND', 'That question is not in this team.')
    const member = this.member(team, actor, memberId, true)
    requireTeam(member?.id === exchange.to, 'WRONG_MEMBER', 'Only the addressed teammate can answer this question.')
    const answerText = z.string().trim().min(1).max(16000).parse(text)
    const refs = Evidence.parse(evidence ?? [])
    if (exchange.answer) {
      requireTeam(exchange.answer.text === answerText && serial(exchange.answer.evidence) === serial(refs)
        && exchange.answer.origin === (actor.kind === 'owner' ? 'owner' : 'agent'), 'ANSWER_CONFLICT', 'An answer is already recorded. Ask a follow-up to revise it.')
      return exchange
    }
    const late = exchange.state === 'expired' || exchange.state === 'cancelled'
    exchange.answer = { text: answerText, evidence: refs, author: member.id, origin: actor.kind === 'owner' ? 'owner' : 'agent', at: this.now(), late }
    if (!late) {
      exchange.state = 'answered'
      if (exchange.notify) exchange.continuation = freshReceipt(`team:${team.id}:${exchange.id}:answer`, this.now())
    }
    this.commit(team)
    void this.consumeReceipt(teamId, exchange.id, 'question')
    return structuredClone(exchange)
  }
  async inbox(teamId: string, actor: Actor, memberId?: string): Promise<Record<string, unknown>> {
    this.expire(teamId)
    const team = this.get(teamId)
    const member = this.member(team, actor, memberId, true)
    requireTeam(member, 'MEMBER_REQUIRED', 'Choose whose inbox to read.')
    const questions = team.exchanges.filter(e => e.to === member.id && e.state === 'pending')
    const answers = team.exchanges.filter(e => e.from === member.id && e.answer)
    await Promise.all([
      ...questions.map(e => this.consumeReceipt(teamId, e.id, 'question')),
      ...answers.map(e => this.consumeReceipt(teamId, e.id, 'answer')),
      this.consumeIntroduction(teamId, member.id),
    ])
    return { memberId: member.id, questions, answers: answers.slice(-20) }
  }
  status(teamId: string, questionId: string, actor: Actor): Exchange {
    this.expire(teamId)
    const team = this.get(teamId)
    const member = this.member(team, actor, undefined, true)
    const exchange = team.exchanges.find(e => e.id === OperationId.parse(questionId))
    requireTeam(exchange, 'QUESTION_NOT_FOUND', 'That question is not in this team.')
    requireTeam(!member || member.enabled || exchange.from === member.id || exchange.to === member.id,
      'NOT_A_MEMBER', 'After leaving a channel you can only finish your own exchanges.')
    return exchange
  }
  async readStatus(teamId: string, questionId: string, actor: Actor): Promise<Exchange> {
    const exchange = this.status(teamId, questionId, actor)
    const member = this.member(this.get(teamId), actor, undefined, true)
    if (member?.id === exchange.to) await this.consumeReceipt(teamId, questionId, 'question')
    if (member?.id === exchange.from && exchange.answer) await this.consumeReceipt(teamId, questionId, 'answer')
    return this.status(teamId, questionId, actor)
  }
  memberId(teamId: string, actor: Actor): string {
    const member = this.member(this.get(teamId), actor, undefined, true)
    requireTeam(member, 'MEMBER_REQUIRED', 'Use the member command provided when this harness joined the team.')
    return member.id
  }
  cancel(teamId: string, questionId: string, actor: Actor): Exchange {
    const team = this.get(teamId)
    const member = this.member(team, actor)
    const exchange = team.exchanges.find(e => e.id === OperationId.parse(questionId))
    requireTeam(exchange, 'QUESTION_NOT_FOUND', 'That question is not in this team.')
    requireTeam(!member || member.id === exchange.from, 'WRONG_MEMBER', 'Only the sender or user can cancel a question.')
    if (exchange.state === 'pending') { exchange.state = 'cancelled'; this.commit(team) }
    void this.cancelReceipt(teamId, exchange.id, 'question')
    return structuredClone(exchange)
  }
  setState(teamId: string, state: unknown, actor: Actor): void {
    this.owner(actor)
    const team = this.get(teamId)
    const next = z.enum(['active', 'paused', 'archived']).parse(state)
    requireTeam(team.state !== 'archived' || next === 'archived', 'TEAM_ARCHIVED', 'Archived teams are read-only. Create another team for new work.')
    if (team.state === next) return
    team.state = next
    if (next === 'archived') for (const exchange of team.exchanges) if (exchange.state === 'pending') exchange.state = 'cancelled'
    this.commit(team)
    this.suppressed.clear()
    if (next === 'archived') {
      for (const member of team.members) void this.cancelIntroduction(teamId, member.id)
      for (const exchange of team.exchanges) {
        void this.cancelReceipt(teamId, exchange.id, 'question')
        void this.cancelReceipt(teamId, exchange.id, 'answer')
      }
    }
    void this.pump()
  }
  updateMember(teamId: string, raw: unknown, actor: Actor): void {
    this.owner(actor)
    const input = z.object({ id: OperationId, name: MemberSpec.shape.name, role: MemberSpec.shape.role, enabled: z.boolean() }).parse(raw)
    const team = this.get(teamId)
    requireTeam(!team.channel, 'TAB_MEMBERSHIP', 'Manage channel members by adding or removing harnesses in the swarm.')
    requireTeam(team.state !== 'archived', 'TEAM_ARCHIVED', 'Archived teams are read-only.')
    const member = team.members.find(m => m.id === input.id)
    requireTeam(member, 'MEMBER_NOT_FOUND', 'That teammate is not in this team.')
    requireTeam(member.enabled || !input.enabled, 'MEMBER_REMOVED', 'Add this harness again to create a fresh membership.')
    const removed = member.enabled && !input.enabled
    Object.assign(member, input)
    this.validateMembers(team.members.filter(m => m.enabled))
    if (removed) {
      member.key = randomBytes(32).toString('hex')
      for (const e of team.exchanges) if ((e.to === member.id || e.from === member.id) && e.state === 'pending') e.state = 'cancelled'
    }
    this.commit(team)
    if (!member.enabled) {
      void this.cancelIntroduction(teamId, member.id)
      for (const e of team.exchanges.filter(e => e.to === member.id || e.from === member.id)) {
        void this.cancelReceipt(teamId, e.id, 'question'); void this.cancelReceipt(teamId, e.id, 'answer')
      }
    }
  }
  async addMember(teamId: string, raw: unknown, actor: Actor): Promise<void> {
    this.owner(actor)
    const input = MemberSpec.extend({ id: OperationId }).parse(raw)
    let team = this.get(teamId)
    requireTeam(!team.channel, 'TAB_MEMBERSHIP', 'Manage channel members by adding or removing harnesses in the swarm.')
    const prior = team.members.find(m => m.id === input.id)
    if (prior) {
      requireTeam(serial(MemberSpec.parse(prior)) === serial(MemberSpec.parse(input)), 'ID_CONFLICT', 'That membership ID already names another harness or role.')
      return
    }
    requireTeam(team.state !== 'archived', 'TEAM_ARCHIVED', 'Archived teams are read-only.')
    const runtime = await this.deps.runtime(input)
    requireTeam(runtime && runtime.engine !== 'terminal', 'AGENT_UNAVAILABLE', 'Choose an existing agent on a reachable, paired machine.')
    // Runtime lookup may yield; re-read before reserving to avoid losing another edit.
    team = this.get(teamId)
    if (team.members.some(m => m.id === input.id)) return this.addMember(teamId, input, actor)
    requireTeam(team.state !== 'archived', 'TEAM_ARCHIVED', 'Archived teams are read-only.')
    requireTeam(team.members.length < 32, 'TEAM_FULL', 'This team has reached its retained membership limit.')
    this.validateMembers([...team.members.filter(m => m.enabled), input])
    team.members.push({ ...input, key: randomBytes(32).toString('hex'), enabled: true, joinedAt: this.now(),
      introduction: freshReceipt(`team:${teamId}:${input.id}:intro`, this.now()) })
    this.commit(team)
  }
  private expire(teamId: string): void {
    const team = this.get(teamId)
    let changed = false
    for (const e of team.exchanges) if (e.state === 'pending' && e.expiresAt <= this.now()) { e.state = 'expired'; changed = true }
    if (changed) this.commit(team)
  }
  private async consumeIntroduction(teamId: string, memberId: string): Promise<void> { await this.controlReceipt(teamId, memberId, 'intro', 'consume') }
  private async cancelIntroduction(teamId: string, memberId: string): Promise<void> { await this.controlReceipt(teamId, memberId, 'intro', 'cancel') }
  private async consumeReceipt(teamId: string, questionId: string, kind: 'question' | 'answer'): Promise<void> { await this.controlReceipt(teamId, questionId, kind, 'consume') }
  private async cancelReceipt(teamId: string, questionId: string, kind: 'question' | 'answer'): Promise<void> { await this.controlReceipt(teamId, questionId, kind, 'cancel') }
  private locate(team: Team, subjectId: string, kind: NoticeKind): { member: Member; receipt: Receipt } | null {
    if (kind === 'intro') {
      const member = team.members.find(m => m.id === subjectId)
      return member ? { member, receipt: member.introduction } : null
    }
    if (kind === 'consult') {
      const instruction = team.consultations.find(c => c.id === subjectId)
      const member = team.members.find(m => m.id === instruction?.memberId)
      return instruction && member ? { member, receipt: instruction.receipt } : null
    }
    const exchange = team.exchanges.find(e => e.id === subjectId)
    const receipt = kind === 'question' ? exchange?.delivery : exchange?.continuation
    const member = team.members.find(m => m.id === (kind === 'question' ? exchange?.to : exchange?.from))
    return receipt && member ? { receipt, member } : null
  }
  private async controlReceipt(teamId: string, subjectId: string, kind: 'intro' | 'question' | 'answer', action: 'cancel' | 'consume'): Promise<void> {
    try {
      const team = this.get(teamId), entry = this.locate(team, subjectId, kind)
      if (!entry || ['received', 'cancelled'].includes(entry.receipt.state)) return
      // Reserve the suppression first. A concurrent slow send reply cannot restore a notice.
      if (action === 'consume') {
        entry.receipt.state = 'received'
        entry.receipt.updatedAt = this.now()
        this.commit(team)
      }
      const receipt = await this.deps.delivery(entry.member, action, { id: entry.receipt.id })
      if (receipt && action === 'cancel') this.saveReceipt(teamId, subjectId, kind, receipt)
    } catch { /* Suppression is persisted; pump retries cancellation on the destination. */ }
  }
  private saveReceipt(teamId: string, subjectId: string, kind: NoticeKind, receipt: Receipt): void {
    if (this.stopped) return
    const latest = this.get(teamId), current = this.locate(latest, subjectId, kind)
    if (!current || ['received', 'cancelled'].includes(current.receipt.state) || serial(current.receipt) === serial(receipt)) return
    Object.assign(current.receipt, receipt)
    if (!receipt.reason) delete current.receipt.reason
    this.commit(latest)
  }
  pump(): Promise<void> {
    return this.pumping ??= this.pumpNow().finally(() => { this.pumping = null })
  }
  private async pumpNow(): Promise<void> {
    if (this.stopped) return
    this.start()
    const work: Promise<void>[] = []
    for (const existing of this.teams.values()) {
      this.expire(existing.id)
      const team = this.get(existing.id)
      for (const member of team.members) {
        if (!team.channel || !member.enabled || team.members.filter(m => m.enabled).length > 1) work.push(this.sync(team, member.id, 'intro'))
      }
      for (const instruction of team.consultations) work.push(this.sync(team, instruction.id, 'consult'))
      for (const e of team.exchanges) {
        work.push(this.sync(team, e.id, 'question'))
        if (e.continuation) work.push(this.sync(team, e.id, 'answer'))
      }
    }
    await Promise.all(work)
  }
  private async sync(team: Team, subjectId: string, kind: NoticeKind): Promise<void> {
    const entry = this.locate(team, subjectId, kind)
    if (!entry || this.flights.has(entry.receipt.id)) return
    const exchange = kind === 'question' || kind === 'answer' ? team.exchanges.find(e => e.id === subjectId)! : undefined
    const instruction = kind === 'consult' ? team.consultations.find(c => c.id === subjectId)! : undefined
    const mayFinish = !!team.channel && !!exchange
    const state = this.effectiveState(team)
    const suppressed = state !== 'active' || (!entry.member.enabled && !mayFinish) || ['cancelled', 'expired'].includes(exchange?.state ?? '')
    if (!suppressed && isTerminalReceipt(entry.receipt) && !['received', 'cancelled'].includes(entry.receipt.state)) return
    this.flights.add(entry.receipt.id)
    try {
      if (suppressed || ['received', 'cancelled'].includes(entry.receipt.state)) {
        // Terminal suppressions are cheap local no-ops once the target agrees. The cached ack avoids
        // endless remote cancellation polls, and reconnect/restart starts reconciliation anew.
        if (this.suppressed.has(entry.receipt.id)) return
        const action = entry.receipt.state === 'received' ? 'consume' : entry.receipt.state === 'cancelled' ? 'cancel'
          : state === 'paused' && (entry.member.enabled || mayFinish) && !['cancelled', 'expired'].includes(exchange?.state ?? '') ? 'hold' : 'cancel'
        const receipt = await this.deps.delivery(entry.member, action, { id: entry.receipt.id })
        if (receipt) this.saveReceipt(team.id, subjectId, kind, receipt)
        this.suppressed.add(entry.receipt.id)
        return
      }
      if (isTerminalReceipt(entry.receipt)) return
      let receipt = await this.deps.delivery(entry.member, 'status', { id: entry.receipt.id })
      if (receipt && ['queued', 'pending'].includes(receipt.state)) receipt = await this.deps.delivery(entry.member, 'release', { id: entry.receipt.id })
      if (!receipt || receipt.state === 'pending') {
        const command = memberCommand(team, entry.member, this.deps.command(entry.member))
        const text = kind === 'intro' ? introduction(team, entry.member, command) : kind === 'consult' ? consultPrompt(team, entry.member, command)
          : kind === 'question' ? questionPrompt(team, exchange!, command) : answerPrompt(team, exchange!, command)
        receipt = await this.deps.delivery(entry.member, 'send', { id: entry.receipt.id, agentId: entry.member.agentId, text,
          ...(team.channel ? { channel: true } : {}),
          expiresAt: kind === 'intro' ? entry.member.introductionExpiresAt ?? entry.member.joinedAt + 86_400_000 : kind === 'consult' ? instruction!.createdAt + 900_000 : kind === 'question' ? exchange!.expiresAt : exchange!.answer!.at + 86_400_000 })
      }
      if (!receipt || this.stopped) return
      const latest = this.get(team.id), current = this.locate(latest, subjectId, kind)!
      const latestExchange = kind === 'question' || kind === 'answer' ? latest.exchanges.find(e => e.id === subjectId) : undefined
      const stillMayFinish = !!latest.channel && !!latestExchange
      const latestState = this.effectiveState(latest)
      if (['received', 'cancelled'].includes(current.receipt.state) || latestState !== 'active' || (!current.member.enabled && !stillMayFinish) || ['cancelled', 'expired'].includes(latestExchange?.state ?? '')) {
        const response = await this.deps.delivery(current.member, current.receipt.state === 'received' ? 'consume' : latestState === 'paused' && (current.member.enabled || stillMayFinish) && !['cancelled', 'expired'].includes(latestExchange?.state ?? '') ? 'hold' : 'cancel', { id: current.receipt.id })
        if (response) this.saveReceipt(latest.id, subjectId, kind, response)
        return
      }
      this.saveReceipt(latest.id, subjectId, kind, receipt)
    } catch (error) {
      if (this.stopped) return
      const latest = this.get(team.id), current = this.locate(latest, subjectId, kind)
      if (!current || isTerminalReceipt(current.receipt)) return
      const reason = error instanceof TeamError ? error.message : 'Machine unreachable. Waiting to reconcile this same delivery.'
      if (current.receipt.reason !== reason) { current.receipt.reason = reason; this.commit(latest) }
    } finally { this.flights.delete(entry.receipt.id) }
  }
  private readonly suppressed = new Set<string>()
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null }
}
