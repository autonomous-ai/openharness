import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { poolRows } from './hostRows.test-support.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { stableId } from '../src/superTabs/model.js'

// Security review 1 of #2115: its two-person probes, kept as regressions. The three that showed a leak at db0379898
// (routing history, archived tasks awaiting a report, sequence-only paging) now assert the fix; the rest are as written.
// The summary half of the archived probe is cli/src/superTabs/buddyStatus.spec.ts: backend CI installs no CLI packages.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '300000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_buddies_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const [machineId, user] of [['owner-mac', owner], ['peer-mac', peer]] as const) {
    await db.machine.create({ data: { machineId, userId: user.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Chat with PM from before Buddies replaced it (10-29): nobody opens one now, so a stored group is made one, as
 *  superTabLiveness.test.ts does. What was written or asked there before stays. */
async function closedPmChat(f: { store: SuperTabStore; tab: string }, conversationId: string, personIds: string[]): Promise<string> {
  const people = (await f.store.read(owner, f.tab)).state.people
  const row = await db.swarmGroup.findFirstOrThrow({ where: { tabId: f.tab, key: conversationId } })
  await db.swarmGroup.update({ where: { id: row.id }, data: { data: { ...row.data as object,
    audience: { people: personIds.map(id => ({ id, generation: people.find(p => p.id === id)!.generation })) } } } })
  return conversationId
}

/** A Swarm whose PM runs on the owner's Mac, peer a member with their own Mac in the Machines list, and Buddies on. */
async function swarm() {
  const store = new SuperTabStore(db, () => Date.now())
  const tab = (await store.create(owner, randomUUID(), 'Buddies', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string, hostMachineId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId, hostMachineId)
  const invitation = await execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const lead = String((await execute({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'PM',
    configuration: config, lead: true })).result.agentId)
  await execute({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 }, peer)
  const generation = (await poolRows(store, peer, 'peer-mac')).find(p => p.tabId === tab)!.machine.generation
  await store.observeMachine(peer, tab, 'peer-mac', { generation, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
  return { store, tab, execute, lead }
}

/** peer's Buddy, added and started by peer-mac's host as a running host does. */
async function buddy(f: Awaited<ReturnType<typeof swarm>>) {
  const added = await f.execute({ type: 'buddy.create', projectId: 'lead', machineId: 'peer-mac', engine: 'claude' }, peer)
  const startId = String(added.result.startId), chat = String(added.result.conversationId)
  const pool = (await poolRows(f.store, peer, 'peer-mac')).find(p => p.tabId === f.tab)!
  const host = (command: Command) => f.execute(command, peer, undefined, 'peer-mac')
  await host({ type: 'agent.startDispatch', startId })
  const agentId = String((await host({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config })).result.agentId)
  await host({ type: 'agent.startSettled', startId, warning: null })
  return { chat, agentId, pool }
}


describe('security review 1 of #2115: a Buddy\'s reads, probed by two people', () => {
  it('keeps routing history and route rows from another person\'s Buddy', async () => {
    const f = await swarm(), {agentId} = await buddy(f)
    const group = String((await f.execute({type:'conversation.create', projectId:'lead', title:'Routing privacy probe', brief:'', checks:[]})).result.conversationId)
    const decision:any = { assessment:{difficulty:'low',risk:'low',why:'Small task'},
      candidates:[{id:'c0',kind:'new',machineId:'owner-mac',engine:'claude',model:'opus',effort:'high',quality:3,cost:3,
        title:'Engineer · Claude opus high · OWNER-PRIVATE-HOST',label:'Candidate on OWNER-PRIVATE-HOST'}],
      excluded:[{title:'OTHER-PRIVATE-HOST',reason:'Owner rule: do not use this machine'}], floor:1,notes:false,pick:'c0',via:'only',p:null,belowFloor:false,why:'Only candidate'}
    const id=String((await f.execute({type:'route.record',conversationId:group,decision},owner,f.lead)).result.routeDecisionId)
    expect(JSON.stringify(await f.store.routeDecision(owner,f.tab,id,f.lead))).toContain('OWNER-PRIVATE-HOST')
    await expect(f.store.routeDecision(peer,f.tab,id,agentId)).rejects.toThrow('A Buddy reads no routing')
    await expect(f.store.routeDecisions(peer,f.tab,agentId)).rejects.toThrow('A Buddy reads no routing')
    expect(JSON.stringify(await f.store.messages(owner,f.tab,group,{},f.lead))).toContain('OWNER-PRIVATE-HOST')
    expect(JSON.stringify(await f.store.messages(peer,f.tab,group,{},agentId))).not.toContain('OWNER-PRIVATE-HOST')
    await expect(f.store.routeDecision(peer,f.tab,'invented-route-id',agentId)).rejects.toThrow()
  })

  it('still hands a Buddy an archived task awaiting the PM\'s report, in the active set its summary shows', async () => {
    const f=await swarm(), {agentId}=await buddy(f)
    const group=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Archived but unsummarized',brief:'',checks:[]})).result.conversationId)
    await f.execute({type:'message.send',conversationId:group,text:'Completed task report',replyTo:null,recipientIds:[]})
    await f.execute({type:'conversation.archive',conversationId:group,archived:true})
    const reads=new SwarmReads(f.store), active=await reads.firstLoad(peer,f.tab,agentId)
    const held=active.groups.find(g=>g.key===group)!
    expect(held.data.archived).toBe(true)
    expect(held.data.dormant).not.toBe(true)
    expect((await reads.dormant(peer,f.tab,{projectId:'lead'},agentId)).groups.map(g=>g.key)).not.toContain(group)
    // So the summary shows it, marked archived (buddyStatus.spec.ts), and it is in one of the two views.
  })

  it('refuses private chats, other Buddies, Leads and other-project groups even with forged paging inputs',async()=>{
    const f=await swarm()
    const privateChat=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Owners private chat',brief:'',checks:[]})).result.conversationId)
    await f.execute({type:'message.send',conversationId:privateChat,text:'PRIVATE FIXTURE TEXT',replyTo:null,recipientIds:[]})
    await closedPmChat(f,privateChat,[owner.sub])
    const web:any=(await f.execute({type:'project.create',name:'Other project',visibility:'public',brief:''})).result
    const other=String((await f.execute({type:'conversation.create',projectId:web.projectId,title:'Other project task',brief:'',checks:[]})).result.conversationId)
    const {agentId}=await buddy(f)
    await f.execute({type:'machine.contribute',machineId:'owner-mac',name:'Owner Mac',cwd:'/owner/repo',scope:'swarm',engines:['claude'],maxAgents:2})
    const gen=(await poolRows(f.store,owner,'owner-mac')).find(p=>p.tabId===f.tab)!.machine.generation
    await f.store.observeMachine(owner,f.tab,'owner-mac',{generation:gen,resources:{cpuPercent:10,memoryTotalBytes:32e9,memoryUsedBytes:4e9,diskFreeBytes:120e9,diskTotalBytes:500e9,projectDiskFreeBytes:120e9,deviceType:'Laptop',chip:'Fixture',os:'macOS',gpuPercent:null},quotas:[],tools:{},runningHarnessIds:[],stoppedHarnessIds:[]})
    const ownerBuddyChat=String((await f.execute({type:'buddy.create',projectId:'lead',machineId:'owner-mac',engine:'claude'})).result.conversationId)
    const leads=(await f.store.read(owner,f.tab)).state.leadsConversationId!
    const reads=new SwarmReads(f.store)
    for(const id of [privateChat,ownerBuddyChat,leads,web.conversationId,other,'invented-group-id']){
      await expect(f.store.messages(peer,f.tab,id,{before:Number.MAX_SAFE_INTEGER,messageId:'invented-message-id'},agentId)).rejects.toThrow('unavailable')
      await expect(reads.group(peer,f.tab,id,agentId)).rejects.toThrow('unavailable')
    }
    const cursor=Buffer.from(JSON.stringify({la:Date.now()+86400000,k:privateChat})).toString('base64url')
    // Another project's archived list is refused outright, before any read (security re-check 2 of #2115).
    await expect(reads.dormant(peer,f.tab,{projectId:web.projectId,before:cursor},agentId)).rejects.toThrow('unavailable')
  })

  it('reloads cached group access after loss of private-project membership and denies all group reads',async()=>{
    const f=await swarm(), {agentId,chat}=await buddy(f)
    const group=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Membership probe',brief:'',checks:[]})).result.conversationId)
    await f.execute({type:'project.sharing',projectId:'lead',visibility:'private',memberIds:[peer.sub]})
    const reads=new SwarmReads(f.store), before=await reads.firstLoad(peer,f.tab,agentId)
    expect(before.groups.map(g=>g.key)).toContain(group)
    await f.execute({type:'project.sharing',projectId:'lead',visibility:'private',memberIds:[]})
    expect(await reads.changes(peer,f.tab,before.cursor,agentId)).toEqual({reload:true})
    expect((await reads.firstLoad(peer,f.tab,agentId)).groups).toEqual([])
    for(const id of [group,chat,'lead']) await expect(f.store.messages(peer,f.tab,id,{},agentId)).rejects.toThrow('unavailable')
    expect((await f.store.decisions(peer,f.tab,'open',agentId)).decisions).toEqual([])
    expect((await reads.dormant(peer,f.tab,{projectId:'lead'},agentId)).groups).toEqual([])
  })
})

it('pages messages that share a sequence by sequence and id, as the CLI now sends them', async()=>{
  const f=await swarm(), {agentId}=await buddy(f)
  const group=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Legacy history',brief:'',checks:[]})).result.conversationId)
  const ids=Array.from({length:150},(_,i)=>`legacy-${randomUUID()}-${String(i).padStart(3,'0')}`)
  await db.superTabMessage.createMany({data:ids.map(id=>({id,tabId:f.tab,conversationId:group,sequence:0,author:{kind:'person',id:owner.sub,name:owner.email},text:id,replyTo:null,recipientIds:[]}))})
  const first=await f.store.messages(peer,f.tab,group,{},agentId)
  expect(first.messages).toHaveLength(100)
  expect(first.next).not.toBeNull()
  // A sequence alone, as the CLI sent it at db0379898, skips them all; the CLI now refuses a cursor without the id.
  expect((await f.store.messages(peer,f.tab,group,{before:first.messages[0].sequence},agentId)).messages).toHaveLength(0)
  const next=await f.store.messages(peer,f.tab,group,{before:first.next!.sequence,beforeId:first.next!.id},agentId)
  expect(next.messages).toHaveLength(50)
  expect(new Set([...first.messages,...next.messages].map(m=>m.id)).size).toBe(150)
})

it('does not disclose a decision question from a private chat visible to its own person',async()=>{
  const f=await swarm()
  // Asked before the chat closed as a Chat with PM: its person still reads it there (projects.ts readsRecordsIn).
  const privateChat=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Shared private',brief:'',checks:[]})).result.conversationId)
  await f.execute({type:'decision.ask',conversationId:privateChat,personId:peer.sub,questions:[{question:'PRIVATE QUESTION SENTINEL',options:['Yes','No'],recommended:0,unblocks:'Private plan'}]},owner,f.lead)
  await closedPmChat(f,privateChat,[owner.sub,peer.sub])
  expect(JSON.stringify(await f.store.decisions(peer,f.tab,'open'))).toContain('PRIVATE QUESTION SENTINEL')
  const {agentId}=await buddy(f)
  expect(JSON.stringify(await f.store.decisions(peer,f.tab,'open',agentId))).not.toContain('PRIVATE QUESTION SENTINEL')
})
it('denies the old Buddy identity after its person leaves and rejoins',async()=>{
  const f=await swarm(), {agentId}=await buddy(f)
  await f.execute({type:'member.remove',userId:peer.sub})
  await expect(f.store.messages(peer,f.tab,'lead',{},agentId)).rejects.toThrow()
  const invitation=await f.execute({type:'invite.create',email:peer.email,role:'collaborator',conversationId:'lead'})
  await f.execute({type:'invite.accept',inviteId:String(invitation.result.inviteId)},peer)
  expect((await f.store.messages(peer,f.tab,'lead',{})).messages).toBeDefined()
  await expect(f.store.messages(peer,f.tab,'lead',{},agentId)).rejects.toThrow()
  await expect(new SwarmReads(f.store).firstLoad(peer,f.tab,agentId)).rejects.toThrow()
})

it('reads a machine leaving the Swarm without its name, in the project chat and in a task (security pass at 018bdd7b8)', async () => {
  const f = await swarm(), { agentId } = await buddy(f)
  await db.machine.create({ data: { machineId: 'probe-studio', userId: owner.sub, apiKey: 'fixture-probe-studio', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await f.execute({ type: 'machine.contribute', machineId: 'probe-studio', name: 'OWNER-STUDIO-HOST', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 })
  const gen = (await poolRows(f.store, owner, 'probe-studio')).find(p => p.tabId === f.tab)!.machine.generation
  await f.store.observeMachine(owner, f.tab, 'probe-studio', { generation: gen, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
    diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Desktop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
  quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
  const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Studio task', brief: '', checks: [] })).result.conversationId)
  await f.execute({ type: 'agent.add', conversationId: group, machineId: 'probe-studio', harnessId: randomUUID(), name: 'Builder', configuration: config, lead: false })
  const removalId = String((await f.execute({ type: 'machine.remove', machineId: 'probe-studio' })).result.removalId)
  await f.store.execute(owner, f.tab, { operationId: `machine-cleaned-${removalId}`, command: { type: 'machine.cleaned', machineId: 'probe-studio', removalId } })

  const pm = [...(await f.store.messages(owner, f.tab, 'lead', {}, f.lead)).messages, ...(await f.store.messages(owner, f.tab, group, {}, f.lead)).messages]
  const left = pm.find(m => m.text.startsWith('OWNER-STUDIO-HOST left the Swarm'))!, removed = pm.find(m => m.text.includes('removed OWNER-STUDIO-HOST from the Swarm'))!
  expect([left, removed].map(m => (m.source as { kind?: string }).kind)).toEqual(['machine-left', 'machine-removed'])
  const seen = [...(await f.store.messages(peer, f.tab, 'lead', {}, agentId)).messages, ...(await f.store.messages(peer, f.tab, group, {}, agentId)).messages]
  expect(seen.find(m => m.id === left.id)!.text).toBe('A machine left the Swarm: its host confirmed its cleanup.')
  expect(seen.find(m => m.id === removed.id)!.text).toMatch(/^owner removed a machine from the Swarm, and \S+ with it\.$/)
  expect(JSON.stringify(seen)).not.toContain('OWNER-STUDIO-HOST')
})

// Threads (Batch X) through a Buddy's reads, the security reviewer's three cases on the merge of #2115 (Lead, 10-29).
describe('a Buddy and threads', () => {
  const send = (f: Awaited<ReturnType<typeof swarm>>, conversationId: string, text: string, replyTo: string | null = null, user = owner, as?: string) =>
    f.execute({ type: 'message.send', conversationId, text, replyTo, recipientIds: [] }, user, as).then(r => String(r.result.messageId))

  it('reads no thread of a private chat, its root or its replies, though its person still has them on record', async () => {
    // Closed as a Chat with PM before anyone reads the Swarm: the fixture edits the stored row, which no cached read sees.
    const f = await swarm()
    const chat = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Private thread', brief: '', checks: [] })).result.conversationId)
    const root = await send(f, chat, 'PRIVATE ROOT SENTINEL')
    await send(f, chat, 'PRIVATE REPLY SENTINEL', root)
    await closedPmChat(f, chat, [owner.sub, peer.sub])
    const { agentId } = await buddy(f)
    for (const cursor of [{}, { thread: root }, { messageId: root }]) {
      await expect(f.store.messages(peer, f.tab, chat, cursor, agentId)).rejects.toThrow('unavailable')
    }
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    expect(JSON.stringify(read)).not.toMatch(/PRIVATE (ROOT|REPLY) SENTINEL/)
    expect(read.groups.map(g => g.key)).not.toContain(chat)
  })

  it('reads no thread in another person\'s Buddy chat', async () => {
    const f = await swarm(), { agentId } = await buddy(f)
    // The owner's own Buddy, on their own Swarm machine, opens their Buddy chat.
    await f.execute({ type: 'machine.contribute', machineId: 'owner-mac', name: 'Owner Mac', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2 })
    const gen = (await poolRows(f.store, owner, 'owner-mac')).find(p => p.tabId === f.tab)!.machine.generation
    await f.store.observeMachine(owner, f.tab, 'owner-mac', { generation: gen, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9,
      diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    const ownersChat = String((await f.execute({ type: 'buddy.create', projectId: 'lead', machineId: 'owner-mac', engine: 'claude' })).result.conversationId)
    const root = await send(f, ownersChat, 'OWNER BUDDY ROOT')
    await send(f, ownersChat, 'OWNER BUDDY REPLY', root)
    for (const cursor of [{}, { thread: root }, { messageId: root }]) {
      await expect(f.store.messages(peer, f.tab, ownersChat, cursor, agentId)).rejects.toThrow('unavailable')
    }
    const read = await new SwarmReads(f.store).firstLoad(peer, f.tab, agentId)
    expect(read.groups.map(g => g.key)).not.toContain(ownersChat)
    expect(JSON.stringify(read)).not.toMatch(/OWNER BUDDY (ROOT|REPLY)/)
  })

  it('reads the replies to a route row as people wrote them, never the route row, its id or its thread line', async () => {
    const f = await swarm(), { agentId } = await buddy(f)
    const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Routed task', brief: '', checks: [] })).result.conversationId)
    const decision: any = { assessment: { difficulty: 'low', risk: 'low', why: 'Small task' },
      candidates: [{ id: 'c0', kind: 'new', machineId: 'owner-mac', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
        title: 'Engineer · Claude opus high · OWNER-PRIVATE-HOST', label: 'Candidate on OWNER-PRIVATE-HOST' }],
      excluded: [], floor: 1, notes: false, pick: 'c0', via: 'only', p: null, belowFloor: false, why: 'Only candidate' }
    await f.execute({ type: 'route.record', conversationId: group, decision }, owner, f.lead)
    const route = (await f.store.messages(owner, f.tab, group, {}, f.lead)).messages.find(m => (m.source as { kind?: string } | null)?.kind === 'route')!
    const reply = await send(f, group, 'Agreed, go ahead.', route.id)
    // A reply from before threads names what it answered and nothing else.
    const legacy = `legacy-${randomUUID()}`
    await db.superTabMessage.create({ data: { id: legacy, tabId: f.tab, conversationId: group, sequence: 900,
      author: { kind: 'person', id: owner.sub, name: owner.email }, text: 'Old reply to the route.', replyTo: route.id, recipientIds: [] } })
    // The PM sees the route row as a thread root with its reply.
    const pm = await f.store.messages(owner, f.tab, group, {}, f.lead)
    expect(pm.threads.map(t => t.id)).toContain(route.id)

    const seen = await f.store.messages(peer, f.tab, group, {}, agentId)
    expect(seen.messages.map(m => m.id)).toContain(reply)
    expect(seen.messages.map(m => m.id)).not.toContain(route.id)
    expect(seen.threads.map(t => t.id)).not.toContain(route.id)
    // The reply reads as a message of its own: no pointer to the row the Buddy may not read.
    expect(seen.messages.find(m => m.id === reply)!.thread ?? null).toBeNull()
    // Its thread reads like a message it may not read and like a thread that is not there: an empty page (review 2 of #2168).
    const empty = { messages: [], next: null, threads: [] }
    expect(await f.store.messages(peer, f.tab, group, { thread: route.id }, agentId)).toMatchObject(empty)
    expect(await f.store.messages(peer, f.tab, group, { thread: 'invented-root' }, agentId)).toMatchObject(empty)
    expect((await f.store.messages(owner, f.tab, group, { thread: route.id }, f.lead)).messages.map(m => m.id)).toEqual([route.id, reply])
    expect(seen.messages.find(m => m.id === legacy)!.replyTo).toBeNull()
    // Nothing names the route row: not a reply's thread or reply-to, not a reply line (review 1 of #2168).
    expect(JSON.stringify(seen)).not.toContain(route.id)
    expect(JSON.stringify(seen)).not.toContain('OWNER-PRIVATE-HOST')
  })
})

// Every reader (review 1 of #2168): a reply to a row the reader may not see, an agent-only note here, names nothing of it.
// Merged with #2177 (main): a new reply to a notice only its recipients read is saved in the chat, not the notice's thread,
// for every reader (commands.ts). The read-side rule still covers a reply saved in such a thread earlier.
it('gives no reader a pointer to, or reply line for, an agent-only note it may not see; its recipient keeps them', async () => {
  const f = await swarm(), { agentId } = await buddy(f)
  // The Lead's note to itself in the project chat, then its own reply to that note.
  const note = String((await f.execute({ type: 'message.send', conversationId: 'lead', text: 'AGENT ONLY NOTE', replyTo: null,
    recipientIds: [f.lead], agentOnly: true }, owner, f.lead)).result.messageId)
  const reply = String((await f.execute({ type: 'message.send', conversationId: 'lead', text: 'Following up on my note.', replyTo: note,
    recipientIds: [] }, owner, f.lead)).result.messageId)
  // A reply saved in the note's thread before #2177 kept such replies in the chat.
  const sent = (await db.superTabMessage.findUnique({ where: { id: reply } }))!
  const earlier = randomUUID().replaceAll('-', '').slice(0, 24)
  await db.superTabMessage.create({ data: { id: earlier, tabId: f.tab, conversationId: 'lead', sequence: sent.sequence + 1,
    author: sent.author as object, text: 'An earlier follow-up.', replyTo: note, thread: note, recipientIds: [], mentions: [] } })

  const lead = await f.store.messages(owner, f.tab, 'lead', {}, f.lead)
  const leadReply = lead.messages.find(m => m.id === reply)!
  expect(leadReply.thread ?? leadReply.id).toBe(reply)
  expect(leadReply.replyTo).toBe(note)
  expect(lead.messages.find(m => m.id === earlier)).toMatchObject({ thread: note, replyTo: note })
  expect(lead.threads.map(t => t.id)).toContain(note)
  expect((await f.store.messages(owner, f.tab, 'lead', { thread: note }, f.lead)).messages.map(m => m.id)).toEqual([note, earlier])
  for (const [user, as] of [[owner, undefined], [peer, agentId]] as const) {
    const read = await f.store.messages(user, f.tab, 'lead', {}, as)
    const shown = read.messages.find(m => m.id === reply)!
    expect(shown.thread ?? shown.id).toBe(reply)
    expect(shown.replyTo).toBeNull()
    expect(read.messages.find(m => m.id === earlier)).toMatchObject({ thread: null, replyTo: null })
    expect(JSON.stringify(read)).not.toContain(note)
    expect(await f.store.messages(user, f.tab, 'lead', { thread: note }, as)).toMatchObject({ messages: [], next: null, threads: [] })
  }
})

// Delta check of the #2168 merge: a task chat's copy of a lost-task notice stored before #2177 marked such copies, whose
// Lead copy reached the PM, is read by no one (pageReads.ts deliveredCopies). Its thread reads as an invented root's for
// every reader, so a page never shows the hidden notice's earlier replies, nor that its thread exists.
it('reads the thread of a hidden task chat copy of a Lead notice as an invented root, for people, the PM and a Buddy', async () => {
  const f = await swarm(), { agentId } = await buddy(f)
  const group = String((await f.execute({ type: 'conversation.create', projectId: 'lead', title: 'Copy probe', brief: '', checks: [] })).result.conversationId)
  const last = await db.superTabMessage.findFirst({ where: { tabId: f.tab }, orderBy: { sequence: 'desc' } })
  const sequence = (last?.sequence ?? 0) + 1, author = { kind: 'agent', id: f.lead, name: 'PM' }
  const copy = randomUUID().replaceAll('-', '').slice(0, 24), earlier = randomUUID().replaceAll('-', '').slice(0, 24)
  await db.superTabMessage.createMany({ data: [
    { id: copy, tabId: f.tab, conversationId: group, sequence, author, text: 'COPY OF A LOST TASK NOTICE', replyTo: null, thread: copy,
      recipientIds: [], mentions: [], source: { kind: 'work-lost' } },
    { id: stableId(copy, 'lead'), tabId: f.tab, conversationId: 'lead', sequence, author, text: 'COPY OF A LOST TASK NOTICE', replyTo: null,
      thread: stableId(copy, 'lead'), recipientIds: [f.lead], mentions: [], source: { kind: 'work-lost' } },
    { id: earlier, tabId: f.tab, conversationId: group, sequence: sequence + 1, author: { kind: 'person', id: owner.sub, name: owner.email },
      text: 'EARLIER REPLY UNDER THE COPY', replyTo: copy, thread: copy, recipientIds: [], mentions: [] }] })

  for (const [user, as] of [[owner, undefined], [owner, f.lead], [peer, agentId]] as const) {
    const invented = await f.store.messages(user, f.tab, group, { thread: 'a'.repeat(24) }, as)
    expect(invented).toMatchObject({ messages: [], next: null, threads: [] })
    expect(await f.store.messages(user, f.tab, group, { thread: copy }, as)).toEqual(invented)
  }
})
