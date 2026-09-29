#!/usr/bin/env node
// Production TypeScript bridge/art -> real cJSON parser -> production C renderer.
// All inputs are fixtures. No app, physical device, sockets or account data.
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {build} from '../../cli/node_modules/esbuild/lib/main.js'
const root=fileURLToPath(new URL('../../',import.meta.url))
const out=process.env.COMPANION_CHECK_OUT||mkdtempSync(join(tmpdir(),'companion-check-'))
mkdirSync(out,{recursive:true})
await build({stdin:{contents:`export * from './companionState.ts';export * from './companionArt.ts';export * from './cableSession.ts';export * from './cableFrame.ts';export * from './dialLog.ts'`,resolveDir:join(root,'cli/src/cable')},
  outfile:join(out,'bridge.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const {DesktopCompanion,companionArt,COMPANION_EMOTIONS,CableSession,CableDecoder,CableType,encodeCableFrame,DialLog}=await import(pathToFileURL(join(out,'bridge.mjs')))
let clock=1000,revision=0,transfer=0
const host=new DesktopCompanion(()=>{},()=>clock)
const messages=[]
const emit=(message,accept=true,scene,wire)=>messages.push({at:clock,message,accept,
  wire:wire??Buffer.from(encodeCableFrame(CableType.Json,Buffer.from(JSON.stringify(message)))).toString('hex'),
  ...(scene!==undefined?{scene}:{})})
const writes=[]
const decoder=new CableDecoder()
let port
const cable=new CableSession({
  localMachine:()=>({id:'fixture',name:'Fixture'}),listMachines:async()=>({machines:[],source:'backend'}),
  selectedMachine:()=> 'fixture',listSwarms:()=>({selected:'',swarms:[],tiles:[]}),listUnread:()=>[],
  appName:()=> 'harness',voiceLang:()=> 'en',listAgents:async()=>[],agentTotal:()=>0,
  activeSwarm:()=>'',describe:()=>undefined,recentSummaries:async()=>[],log:()=>{},
  companion:()=>host.snapshot(),companionArt
},new DialLog(join(out,'logs')),async (_data,closed)=>port={
  path:'/fixture/never-opened',isOpen:true,
  write:async bytes=>decoder.feed(Buffer.from(bytes),frame=>{
    if(frame.type!==CableType.Json)return
    const message=JSON.parse(Buffer.from(frame.payload).toString())
    if(message.t.startsWith('companion.'))writes.push({message,wire:Buffer.from(bytes).toString('hex')})
  }),close:async()=>{port.isOpen=false;closed('fixture complete')}
})
// Inject only a memory port. These methods are the production handshake and
// publisher; no serial discovery, tmux or real daemon is started.
await cable.tryOpen()
await cable.onMessage({t:'hello',product:'harness',mac:'fixture',fw:'fixture',companion:1})
writes.length=0
async function present(p,scene='') {
  const state={v:1,window:'fixture-desktop',epoch:1,revision:++revision,enabled:true,foreground:true,motion:true,
    feeling:{emotion:'content',reason:'fixture',intensity:1},...p}
  await ship(state,scene)
}
async function ship(state,scene='') {
  if(!host.update('fixture-socket',state))throw Error('desktop state refused')
  await cable.syncCompanion()
  if(!writes.length)throw Error('CableSession failed to publish companion state')
  const rows=writes.splice(0),begin=rows.find(r=>r.message.t==='companion.art.begin')
  for(const [i,row] of rows.entries()) {
    const m=row.message
    emit(m,true,state.enabled&&i===rows.length-1?scene:undefined,row.wire)
    if(m.t==='companion.art.begin') {
      transfer=m.transfer
      // Inject a lost transfer ending too soon. Firmware must refuse it.
      emit({t:'companion.art.end',key:m.key,transfer},false)
    }
  }
  if(begin)emit({t:'companion.art.frame',key:'retired-account',transfer,index:0,rows:'oo',mats:'pp'},false)
  clock+=10000
}
if(process.env.COMPANION_DESKTOP_WIRE) {
  const wire=JSON.parse(readFileSync(process.env.COMPANION_DESKTOP_WIRE,'utf8'))
  const ages=new Set(),identities=new Set(),stages=new Set()
  for(const state of wire) {
    if(state.creature){ages.add(state.creature.version);identities.add(`${state.creature.uid}/${state.creature.seed}`)}
    if(state.egg)stages.add(state.egg.stage)
    await ship(state,state.enabled?`desktop-${state.revision}`:'')
  }
  if(ages.size!==3||identities.size!==1||!stages.has('p0')||!stages.has('p4')||!stages.has('hatchling')||wire.at(-1)?.enabled!==false)
    throw Error('Incomplete desktop lifecycle fixture')
  console.log(`Production desktop serialization: ${wire.length} snapshots, one individual, all three ages`)
}
for(const kind of ['first','turn','setup','week','marathon','night','history','easter'])for(const stage of ['p0','p1','p2','p3','p4','rock','burst','tumble','open'])
  await present({phase:stage.startsWith('p')?'egg':'hatching',egg:{kind,stage}},kind==='first'?`egg-${stage}`:'')
for(const version of ['0.1','1.0','2.0'])for(const emotion of COMPANION_EMOTIONS)
  await present({phase:'creature',creature:{uid:'fixture-tim',id:'tim',seed:1363,name:'Tim',version,shiny:false},
    feeling:{emotion,reason:'fixture',intensity:2}},['content','excited','angry','asleep','curious'].includes(emotion)?`tim-${version}-${emotion}`:'')
await present({enabled:false})
emit({t:'companion.art.end',key:'tim:1363:2.0:0:content:reveal',transfer},false)
for(const bad of [{v:2},{serial:-1},{revision:NaN},{window:'\n'},{epoch:1.1},{enabled:'yes'}])
  emit({t:'companion.state',...host.snapshot(),...bad},false)
await cable.stop()
writeFileSync(join(out,'messages.jsonl'),messages.map(x=>JSON.stringify(x)).join('\n')+'\n')
const idf=process.env.IDF_PATH
if(!idf)throw Error('Set IDF_PATH to the ESP-IDF 5.5 checkout (only its cJSON is used)')
const main=join(root,'devices/harness-device/firmware/main'),habitat=join(main,'ui/habitat'),json=join(idf,'components/json/cJSON')
execFileSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize=undefined,bounds',
  '-I',habitat,'-I',main,'-I',json,'-o',join(out,'check'),join(main,'../test/test_companion.c'),
  ...['companion.c','character_layout.c','terminal.c','fonts.c','octopus_font.c'].map(f=>join(habitat,f)),join(json,'cJSON.c'),join(main,'cable_frame.c'),join(main,'cable_json_guard.c')],{stdio:'inherit'})
execFileSync(join(out,'check'),[join(out,'messages.jsonl'),out],{stdio:'inherit'})
console.log(`Review frames and wire replay: ${out}`)
