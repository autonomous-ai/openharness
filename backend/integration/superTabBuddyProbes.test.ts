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
  await execute({ type: 'tab.buddies', enabled: true })
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
      candidates:[{id:'c0',kind:'new',machineId:'owner-mac',engine:'claude',model:'fixture-model',effort:'high',quality:2,cost:2,
        title:'Engineer · Claude fixture-model high · OWNER-PRIVATE-HOST',label:'Candidate on OWNER-PRIVATE-HOST'}],
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
    await f.execute({type:'tab.buddies',enabled:false})
    const privateChat=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Owners private chat',brief:'',checks:[],audience:{personIds:[owner.sub]}})).result.conversationId)
    await f.execute({type:'message.send',conversationId:privateChat,text:'PRIVATE FIXTURE TEXT',replyTo:null,recipientIds:[]})
    await f.execute({type:'tab.buddies',enabled:true})
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
  await f.execute({type:'tab.buddies',enabled:false})
  const privateChat=String((await f.execute({type:'conversation.create',projectId:'lead',title:'Shared private',brief:'',checks:[],audience:{personIds:[owner.sub,peer.sub]}})).result.conversationId)
  await f.execute({type:'decision.ask',conversationId:privateChat,personId:peer.sub,questions:[{question:'PRIVATE QUESTION SENTINEL',options:['Yes','No'],recommended:0,unblocks:'Private plan'}]},owner,f.lead)
  expect(JSON.stringify(await f.store.decisions(peer,f.tab,'open'))).toContain('PRIVATE QUESTION SENTINEL')
  await f.execute({type:'tab.buddies',enabled:true})
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
