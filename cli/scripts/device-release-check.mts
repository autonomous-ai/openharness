/** Offline checks of the exact built/installed bridge. Never imports its CLI entry point. */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { CableDecoder, CableType, encodeCableFrame } from '../src/cable/cableFrame.js'

const args=process.argv.slice(2), option=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1]}
const bundle=option('--bundle'), out=option('--out')
if(!bundle || !out) throw new Error('Usage: tsx scripts/device-release-check.mts --bundle <cli.js> --out <directory>')
fs.mkdirSync(out,{recursive:true})
const code=fs.readFileSync(bundle,'utf8'), hash=crypto.createHash('sha256').update(code).digest('hex')
const ast=ts.createSourceFile(bundle,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), nodes:ts.Node[]=[]
const walk=(n:ts.Node)=>{nodes.push(n);ts.forEachChild(n,walk)};walk(ast)
const classes=nodes.filter((n):n is ts.ClassExpression=>ts.isClassExpression(n)&&n.members.some(m=>ts.isMethodDeclaration(m)&&m.name.getText(ast)==='turnStarted'&&m.getText(ast).includes('turn.started'))&&n.members.some(m=>ts.isMethodDeclaration(m)&&m.name.getText(ast)==='onBytes'))
assert.equal(classes.length,1,'Identify the actual CableSession implementation unambiguously')
const klass=classes[0]
const method=(name:string)=>klass.members.find((n):n is ts.MethodDeclaration=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name)
const decoder=klass.members.find(n=>ts.isPropertyDeclaration(n)&&n.name.getText(ast)==='decoder') as ts.PropertyDeclaration
assert(decoder?.initializer && ts.isNewExpression(decoder.initializer))
const decoderName=decoder.initializer.expression.getText(ast)
const send=method('send');assert(send)
const calls:ts.CallExpression[]=[]
const scan=(n:ts.Node)=>{if(ts.isCallExpression(n))calls.push(n);ts.forEachChild(n,scan)};scan(send)
const encode=calls.find(n=>n.arguments.some(x=>ts.isPropertyAccessExpression(x)&&x.name.text==='Json'));assert(encode)
const kind=encode.arguments.find(x=>ts.isPropertyAccessExpression(x)&&x.name.text==='Json') as ts.PropertyAccessExpression
let now=100000
const context:any={Buffer,console,Map,Set,Promise,JSON,Math,Uint8Array,TextDecoder,TextEncoder,
  setTimeout,clearTimeout,setInterval,clearInterval,
  Date:class extends Date {static now(){return now}},a:(fn:any)=>fn}
// Literal bundle constants only. No CLI top-level code or environment initialization executes.
for(const statement of ast.statements) if(ts.isVariableStatement(statement)) for(const d of statement.declarationList.declarations) {
  if(!ts.isIdentifier(d.name)||!d.initializer)continue
  const raw=d.initializer.getText(ast)
  if(ts.isStringLiteral(d.initializer))context[d.name.text]=d.initializer.text
  else if(/^(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[\da-f]+)$/i.test(raw))context[d.name.text]=Number(raw)
}
const encoderNode=nodes.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.getText(ast)===encode.expression.getText(ast));assert(encoderNode)
const decoderNode=nodes.find((n):n is ts.VariableDeclaration=>ts.isVariableDeclaration(n)&&n.name.getText(ast)===decoderName);assert(decoderNode?.initializer)
const kindNode=nodes.find((n):n is ts.VariableDeclaration=>ts.isVariableDeclaration(n)&&n.name.getText(ast)===kind.expression.getText(ast));assert(kindNode?.initializer)
const codecCalls:ts.CallExpression[]=[]
const scanCodec=(n:ts.Node)=>{if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression))codecCalls.push(n);ts.forEachChild(n,scanCodec)};scanCodec(encoderNode)
const codecHelpers=[...new Set(codecCalls.map(n=>n.expression.getText(ast)))].map(name=>{
 const fn=nodes.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.getText(ast)===name);assert(fn,`Unknown codec dependency ${name}`);return fn
})
// Import only the standalone status parser referenced by this built artifact.
for(const node of ast.statements) if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)) {
  const wanted=node.importClause.namedBindings.elements.filter(e=>(e.propertyName??e.name).text==='terminalActivity')
  if(wanted.length){assert(node.moduleSpecifier.text.startsWith('./device-activity'))
    const helper=await import(new URL(node.moduleSpecifier.text,`file://${path.resolve(bundle)}`).href)
    for(const e of wanted)context[e.name.text]=helper.terminalActivity
  }
}
const sandbox=vm.createContext(context)
for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer?.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      context[declaration.name.text] = vm.runInContext(declaration.initializer.getText(ast), sandbox)
    }
  }
}
// Function declarations are inert until invoked. Register the built functions so
// inlined pure helpers (activity parsing and recap cleanup) use the same bytes as
// the release, without executing any CLI startup statements or loading I/O imports.
for (const statement of ast.statements) if (ts.isFunctionDeclaration(statement) && statement.name) {
  const name = statement.name.text
  if (Object.hasOwn(context, name)) continue
  Object.defineProperty(context, name, { configurable: true, enumerable: true,
    get() {
      const value = vm.runInContext(`(${statement.getText(ast)})`, sandbox)
      Object.defineProperty(context, name, { value, writable: true, configurable: true, enumerable: true })
      return value
    },
    set(value) { Object.defineProperty(context, name, { value, writable: true, configurable: true, enumerable: true }) },
  })
}
// These bounded state holders are constructed by newer CableSession bundles.
// Only their class definitions run here; all host actions remain fixture wiring.
for (const name of ['PassageCarry', 'VoiceDraft', 'QuestionInbox']) {
  const found = nodes.filter((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) &&
    !!n.initializer && ts.isClassExpression(n.initializer) &&
    n.initializer.members.some(m => ts.isClassStaticBlockDeclaration(m) &&
      m.getText(ast).includes(JSON.stringify(name))))
  assert(found.length <= 1, `Ambiguous built ${name} implementation`)
  for (const declaration of found) {
    context[declaration.name.getText(ast)] = vm.runInContext(`(${declaration.initializer!.getText(ast)})`, sandbox)
  }
}
for(const fn of codecHelpers)context[fn.name!.text]=vm.runInContext(`(${fn.getText(ast)})`,sandbox)
context[decoderName]=vm.runInContext(`(${decoderNode.initializer.getText(ast)})`,sandbox)
context[encode.expression.getText(ast)]=vm.runInContext(`(${encoderNode.getText(ast)})`,sandbox)
context[kind.expression.getText(ast)]=vm.runInContext(`(${kindNode.initializer.getText(ast)})`,sandbox)
const Session=vm.runInContext(`(${klass.getText(ast)})`,sandbox)
const providerNodes=nodes.filter(n=>ts.isPropertyAssignment(n)&&n.name.getText(ast)==='activityText') as ts.PropertyAssignment[]
const localMethod=nodes.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='activityText'&&n.getText(ast).includes('this.isLocalAgent')) as ts.MethodDeclaration|undefined
const results:any[]=[], traces:any[]=[]
const check=async(id:string,fn:()=>Promise<void>|void)=>{try{await fn();results.push({id,status:'passed'})}catch(e){results.push({id,status:'failed',error:String(e)})}}
const plain=(x:any)=>JSON.parse(JSON.stringify(x))
const settle=()=>new Promise(r=>setTimeout(r,0))
const until=async(f:()=>boolean)=>{for(let i=0;i<1000&&!f();i++)await new Promise(r=>setTimeout(r,1));assert(f(),'Expected protocol response did not arrive')}
function setup(){
  const sent:any[]=[],frames:Buffer[]=[],logs:string[]=[],turns:any[]=[],scrolls:any[]=[]
  let selected='tab-a',rows=[{id:'a',name:'Fixture Codex',engine:'codex'}]
  const host:any={appName:()=> 'harness',localMachine:()=>({id:'local',name:'Fixture'}),selectedMachine:()=> 'local',voiceLang:()=> 'en',
    listMachines:async()=>({machines:[],source:'backend'}),listSwarms:()=>({selected,swarms:[{id:'tab-a',name:'A',agents:1,panes:1},{id:'tab-b',name:'B',agents:0,panes:0}],tiles:[]}),
    selectSwarm:(id:string)=>{selected=id;rows=id==='tab-a'?[{id:'a',name:'Fixture Codex',engine:'codex'}]:[]},
    listAgents:async()=>rows,agentTotal:()=>1,activeSwarm:()=>selected,recentSummaries:async()=>[],listUnread:()=>[],describe:()=>({name:'Fixture Codex',engine:'codex',machine:'Fixture'}),
    log:(s:string)=>logs.push(s),sendTurn:async(...x:any[])=>turns.push(x),transcribe:async()=> 'Fixture request.',route:async()=>({agentId:'a',confidence:1}),
    focus:async()=>{},openAgent:async()=>{},scrolled:(...x:any[])=>scrolls.push(x),listModels:async()=>[],selectMachine:async()=>({ok:true})}
  const dial={daemon:()=>{},device:()=>{},greeted:()=>{},tick:()=>{}}
  const session=new Session(host,dial,async()=>{throw new Error('Real port opening is forbidden in this test')})
  const peer=new CableDecoder()
  const port={path:'/dev/fixture',isOpen:true,write:async(bytes:Uint8Array)=>{frames.push(Buffer.from(bytes));peer.feed(bytes,(f:any)=>{if(f.type===CableType.Json)sent.push(JSON.parse(Buffer.from(f.payload).toString()))})},close:async()=>{port.isOpen=false;session.onClosed('fixture disconnect')}}
  session.link=port;session.greetedMac='fixture';session.greetedFw='fixture';session.desiredFocus='a'
  const feed=async(message:any,chunk=7)=>{const frame=encodeCableFrame(CableType.Json,Buffer.from(JSON.stringify(message)));for(let i=0;i<frame.length;i+=chunk)session.onBytes(frame.subarray(i,i+chunk));await settle()}
  return {session,host,port,sent,frames,logs,turns,scrolls,feed}
}
await check('built-wire-codec-compatibility',()=>{
 const make=context[encode.expression.getText(ast)],Decoder=context[decoderName]
 for(const len of [0,1,2,319,320,1024,8192]){
  const bytes=Buffer.from(Array.from({length:len},(_,i)=>i&255)),wire=make(CableType.Pcm,bytes)
  assert.deepEqual(Buffer.from(wire),Buffer.from(encodeCableFrame(CableType.Pcm,bytes)))
  for(const chunk of [1,7,512,8200]){const d=new Decoder();let seen=0;for(let i=0;i<wire.length;i+=chunk)d.feed(wire.subarray(i,i+chunk),(f:any)=>{seen++;assert.equal(f.type,CableType.Pcm);assert.deepEqual(Buffer.from(f.payload),bytes)});assert.equal(seen,1)}
 }
})
await check('notification-read-roundtrip-and-stale-occurrences',async()=>{
 const read=nodes.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='readNotification'&&n.getText(ast).includes('this.wiring'))
 assert(read,'Built host must validate exact notification occurrences')
 const Host=vm.runInContext(`(class {${read.getText(ast)}})`,sandbox), owner=new Host(), receipts:any[]=[]
 owner.unread=[{agentId:'a',machineId:'remote',question:true,text:'May I publish?',readToken:'question-2'}]
 owner.wiring={notificationRead:(...args:any[])=>receipts.push(args)}
 const x=setup();x.host.readNotification=owner.readNotification.bind(owner)
 x.host.openAgent=()=>{throw new Error('Reading must not change focus')}
 await x.session.replaceNotifications(owner.unread)
 assert.equal(x.sent.at(-1).items[0].readToken,'question-2')
 for(const token of ['question-1','', 'x'.repeat(64)])await x.feed({t:'notif.read',agentId:'a',readToken:token},1)
 assert.equal(receipts.length,0)
 await x.feed({t:'notif.read',agentId:'a',readToken:'question-2'},1)
 assert.deepEqual(plain(receipts),[['remote','a','question-2']])
 await x.session.agentSeen('a','question-2')
 assert.deepEqual(plain(x.sent.at(-1)),{t:'notif.seen',agentId:'a',readToken:'question-2'})
 owner.unread=[];await x.session.replaceNotifications(owner.unread)
 await x.feed({t:'notif.read',agentId:'a',readToken:'question-2'},7)
 assert.equal(receipts.length,1);assert.deepEqual(plain(x.sent.at(-1)),{t:'notif.replace',items:[]})
})
await check('artifact-status-wiring' ,()=>{
 assert(method('refreshFocusedActivity'),'Installed bridge lacks focused activity delivery')
 assert(method('tick')?.getText(ast).includes('refreshFocusedActivity'),'Activity recovery is never scheduled')
 assert.equal(providerNodes.length,1,'Exactly one live activity capture must be wired')
 assert(localMethod,'Host activity provider must reject remote capture')
})
await check('built-capture-is-local-visible-only',async()=>{
 assert.equal(providerNodes.length,1);assert(localMethod)
 const expr=providerNodes[0].initializer.getText(ast),resolve=expr.match(/(\w+)\.resolve\(/),capture=expr.match(/(\w+)\.capture\(/);assert(resolve&&capture)
 let calls=0;context[resolve[1]]={resolve:(id:string)=>id==='missing'?null:{engine:id==='claude'?'claude':id==='shell'?'terminal':'codex'}}
 context[capture[1]]={capture:async(_session:any,options:any)=>{calls++;assert.deepEqual(plain(options),{mode:'visible',ansi:false});return{state:'succeeded',value:'◦ Working (2s • esc to interrupt)'}}}
 // context is the contextified object; no eager read of unrelated bundle getters.
 const provider=vm.runInContext(`(${expr})`,sandbox)
 const wrapper=vm.runInContext(`(class {${localMethod.getText(ast)}})`,sandbox),host=new wrapper()
 host.isLocalAgent=(id:string)=>id!=='remote';host.wiring={activityText:provider}
 assert.equal(await host.activityText('a'),'Working');assert.equal(calls,1)
 for(const id of ['missing','shell','remote'])assert.equal(await host.activityText(id),null)
 assert.equal(calls,1)
})
for(const [id,label] of [['codex-working','Working'],['claude-activity','Coalescing...']])await check(id,async()=>{
 const x=setup();x.host.activityText=async()=>label
 await x.session.refreshFocusedActivity()
 assert.deepEqual(plain(x.sent).map((m:any)=>[m.t,m.text]),[['turn.started',label],['turn.activity',label]])
 traces.push({id,frames:x.frames.map(b=>b.toString('hex')),expect:{status:label.replace(/\.\.\.$/,''),busy:true,recap:false}})
})
await check('focused-status-throttle',async()=>{const x=setup();let reads=0;x.host.activityText=async()=>{reads++;return'Working'};await x.session.refreshFocusedActivity();await x.session.refreshFocusedActivity();assert.equal(reads,1);now+=3001;await x.session.refreshFocusedActivity();assert.equal(reads,2)})
for(const end of ['done','summary','error','focus','disconnect'])await check(`late-status-after-${end}`,async()=>{
 const x=setup();let finish:(s:string)=>void=()=>{};x.host.activityText=()=>new Promise(r=>finish=r)
 const work=x.session.refreshFocusedActivity();await settle()
 if(end==='done')await x.session.turnDone('a');if(end==='summary')await x.session.summary('a','Completed.','Completed. Fixture text.')
 if(end==='error')await x.session.turnError('a','Stopped');if(end==='focus')await x.session.focusAgent('b');if(end==='disconnect')await x.port.close()
 const count=x.sent.length;finish('Stale...');await work;assert.equal(x.sent.length,count)
})
await check('native-footer-clears-when-absent',async()=>{const x=setup();x.host.activityText=async()=>null;await x.session.refreshFocusedActivity();assert.deepEqual(plain(x.sent),[{t:'turn.activity',agentId:'a',text:''}])})
await check('busy-without-native-footer',async()=>{
 const x=setup();x.host.activityText=async()=>null
 await x.session.turnStarted('a');await x.session.refreshFocusedActivity()
 assert(x.sent.some(m=>m.t==='turn.started'))
 assert.deepEqual(plain(x.sent.at(-1)),{t:'turn.activity',agentId:'a',text:''})
 traces.push({id:'busy-without-native-footer',frames:x.frames.map(b=>b.toString('hex')),expect:{status:'',display_status:'Working',busy:true,recap:false}})
})
await check('capture-failure-is-not-completion',async()=>{const x=setup();x.host.activityText=async()=>{throw new Error('capture unavailable')};await x.session.refreshFocusedActivity();assert.deepEqual(plain(x.sent),[])})
await check('working-to-result-and-next-turn',async()=>{
 const x=setup();x.host.activityText=async()=> 'Working';await x.session.refreshFocusedActivity()
 await x.session.turnDone('a');await x.session.summary('a','The fixture passed.','The fixture passed. Full result.')
 traces.push({id:'completed',frames:x.frames.map(b=>b.toString('hex')),expect:{status:'',busy:false,recap:true}})
 x.frames.length=0;await x.session.turnStarted('a');assert(x.sent.at(-1).text==='Working')
 traces.push({id:'next-turn',frames:x.frames.map(b=>b.toString('hex')),expect:{status:'Working',busy:true,recap:false}})
})
for(const chunk of [1,7,4096])await check(`tab-roundtrip-fragments-${chunk}`,async()=>{
 const x=setup();await x.feed({t:'swarm.select',swarmId:'tab-b'},chunk);await x.feed({t:'agents.list'},chunk)
 await until(()=>x.sent.some(m=>m.t==='agents.end'))
 assert.equal(x.sent.find(m=>m.t==='swarms').selected,'tab-b');assert.equal(x.sent.find(m=>m.t==='agents.end').tab,'tab-b');assert.equal(x.sent.filter(m=>m.t==='agent').length,0)
 await x.feed({t:'swarm.select',swarmId:'tab-a'},chunk);x.sent.length=0;await x.feed({t:'agents.list'},chunk)
 await until(()=>x.sent.some(m=>m.t==='agents.end'));assert.equal(x.sent.find(m=>m.t==='agent').id,'a');assert.equal(x.sent.find(m=>m.t==='agents.end').tab,'tab-a')
})
await check('reconnect-and-repeated-hello',async()=>{const x=setup();x.session.greetedMac=null;await x.feed({t:'hello',product:'harness',mac:'fixture',fw:'fixture',proto:3});await until(()=>x.sent.some(m=>m.t==='agents.end'));const count=x.sent.filter(m=>m.t==='agents.end').length;await x.feed({t:'hello',product:'harness',mac:'fixture',fw:'fixture',proto:3});await settle();assert.equal(x.sent.filter(m=>m.t==='agents.end').length,count);assert.equal(x.sent.filter(m=>m.t==='welcome').length,2)})
const fleetImport=ast.statements.find(n=>ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)&&n.moduleSpecifier.text.startsWith('./device-usb-fleet')) as ts.ImportDeclaration|undefined
if(fleetImport)await check('built-usb-fleet-default-discovery-three-dials-and-disconnect',async()=>{
 const {CableFleet}=await import(new URL((fleetImport.moduleSpecifier as ts.StringLiteral).text,`file://${path.resolve(bundle)}`).href)
 const bindings=fleetImport.importClause?.namedBindings
 assert(bindings&&ts.isNamedImports(bindings))
 const fleetName=bindings.elements.find(e=>(e.propertyName??e.name).text==='CableFleet')?.name.text
 assert(fleetName)
 const constructors=nodes.filter((n):n is ts.NewExpression=>ts.isNewExpression(n)&&n.expression.getText(ast)===fleetName)
 assert.equal(constructors.length,1,'Check the actual deployed USB fleet configuration')
 const config=constructors[0].arguments?.[4]
 const defaults=config?vm.runInNewContext(`(${config.getText(ast)})`,{process:{env:{}}}):{}
 const x=setup(),peers:any[]=[];let attached=0,gone=0,status:any
 x.host.onDialAttached=()=>{attached++};x.host.onDialGone=()=>{gone++};x.host.onDialStatus=(s:any)=>{status=s}
 let present=['tim','tux','production'].map(id=>({path:`/dev/${id}`,serialNumber:id,vendorId:0x303a,productId:0x1001}))
 const fleet=new CableFleet(Session,x.host,out,class {daemon(){}device(){}greeted(){}tick(){}}, {
  ...defaults,
  intervalMs:60000,discover:async()=>present,
  open:async(portPath:string,onData:any,onClosed:any)=>{
   const decoder=new CableDecoder(),p:any={path:portPath,isOpen:true,sent:[],
    write:async(bytes:Uint8Array)=>decoder.feed(bytes,f=>{if(f.type===CableType.Json)p.sent.push(JSON.parse(Buffer.from(f.payload).toString()))}),
    close:async()=>{if(p.isOpen){p.isOpen=false;onClosed('fixture unplug')}},
    say:(m:any)=>onData(Buffer.from(encodeCableFrame(CableType.Json,Buffer.from(JSON.stringify(m)))))}
   peers.push(p);return p
  },
 })
 try {
  fleet.start();await until(()=>peers.length===3);await settle()
  for(const p of peers)p.say({t:'hello',product:'harness',mac:p.path,fw:p.path==='/dev/production'?'0.0.86':'fixture',proto:3})
  await until(()=>peers.every(p=>p.sent.some((m:any)=>m.t==='agents.end')))
  assert.equal(attached,1);assert(fleet.isConnected)
  await fleet.turnStarted('a','Working')
  for(const p of peers)assert(p.sent.some((m:any)=>m.t==='turn.started'&&m.agentId==='a'))
  present=present.slice(1);await fleet.scan()
  assert.equal(peers[0].isOpen,false);assert(peers.slice(1).every(p=>p.isOpen));assert.equal(gone,0);assert.equal(status.attached,true)
  await fleet.turnDone('a');for(const p of peers.slice(1))assert(p.sent.some((m:any)=>m.t==='turn.done'))
  present=[];await fleet.scan();assert.equal(gone,1);assert.equal(status.attached,false)
 } finally {await fleet.stop()}
})
const report={artifact:path.resolve(bundle),sha256:hash,bytes:Buffer.byteLength(code),scope:'Exact built CableSession class and activity wiring, real wire encoder/decoder, isolated app/terminal fixtures; no real app actions, microphone or network.',cases:results,passed:results.filter(r=>r.status==='passed').length,total:results.length}
fs.writeFileSync(path.join(out,'bridge-report.json'),JSON.stringify(report,null,2)+'\n')
fs.writeFileSync(path.join(out,'firmware-traces.json'),JSON.stringify(traces,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
if(report.passed!==report.total)process.exitCode=1
