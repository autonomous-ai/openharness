/** Installer-only dependencies survive core restart; engine dispatch returns to core. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { buildEngineInstallationArgv } from '../../lib/engineLaunch.js'
import type { EngineInstallRecipe } from '../../lib/engineInstall.js'
import { failureReason } from '../../lib/failureReason.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { secureStateDirectory } from '../../lib/secureState.js'
import type { AgentEngine } from '../types.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativeFiles } from './nativeFiles.js'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { NativePaths, verifyNativePathFacts, withoutDevice, type NativePathFact } from './nativePaths.js'

const LIMIT = 262_144
// This is installation history, not launch history: ordinary launches never add
// an entry. Bound exceptional recovery instead of making Stop wait on an ever
// larger synchronous ownership fence. Full records stay on disk for review.
const MAX_INSTALLATIONS = 128
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const identity = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.mode}:${s.uid}`
const version = (s: BigIntStats): string => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
const directoryStamp = (directory: string): string => version(lstatSync(directory, { bigint: true }))
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
interface Link { file: string; digest: string }
interface Authority { version: 1; directory: string }
interface Claim {
  version: 1; token: string; request: string; engine: AgentEngine; recipe: string
  argv: string[]; environment: Record<string, string>
  routes: ReturnType<NativePaths['snapshot']>; previous: Link[]; authority: string; witness: string
}
interface Dispatch { token: string; claim: string; kind: 'run' | 'cancelled' }
interface Result { token: string; claim: string; code: number | null; signal: string | null; notDispatched?: true; detail?: string }
/** `running`: an installer is dispatched and has not settled. `failed`: this request's own installer settled with a
 *  failure, and `detail` is why, in its output's words; it is never run again for this request. */
export type NativeInstallation = { complete: true } | { complete: false; detail: string; running?: true; failed?: true }
const hold = (detail: string): NativeInstallation => ({ complete: false, detail })
const running = (detail: string): NativeInstallation => ({ complete: false, detail, running: true })
// The helper ends its installer at 20 minutes and then records the result. A dispatch older than that with no result
// is a helper that died (a reboot during an install): it is never replayed, and no longer said to be installing, which
// `harness new` would otherwise wait on for minutes at every attempt.
const INSTALLER_SETTLES_MS = 1_200_000 + 60_000
const installing = (dispatched: { file: string } | undefined, detail: string): NativeInstallation => {
  try { if (dispatched && Date.now() - lstatSync(dispatched.file).mtimeMs < INSTALLER_SETTLES_MS) return running(detail) } catch { /* A vanished record is not a live installer. */ }
  return hold(detail)
}

/** Never read a growing journal file without a bound, or tighten foreign permissions to trust it. */
function readRecord(file: string): { text: string; file: string; stamp: string; facts: NativePathFact[]; verify(): void } {
  const paths = new NativePaths(new NativeEvidenceBudget())
  const location = paths.resolveSync(file, true), facts = paths.snapshot()
  if (!location) {
    // An ancestor may be an ordinary alias, such as macOS /var. Absence
    // belongs to the observed physical parent, never a dangling leaf alias.
    const parent = paths.resolveSync(dirname(file), true)
    if (!parent?.info.isDirectory() || !paths.absentLeaf(join(parent.path, basename(file)))) throw Error('Unconfirmed missing installation route')
    paths.verify()
    throw Object.assign(Error('Missing installation record'), { code: 'ENOENT' })
  }
  if (lstatSync(file).isSymbolicLink()) throw Error('Aliased installation record')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let stamp: string, text: string
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > LIMIT || before.ino !== location.info.ino || before.dev !== location.info.dev
      || (before.mode & 0o022n) !== 0n || before.uid !== BigInt(process.getuid!())) throw Error('Unsafe installation record')
    stamp = version(before)
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    for (let calls = 0; offset < bytes.length; calls++) {
      if (calls >= 64) throw Error('Installation record read limit')
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw Error('Truncated installation record')
      offset += count
    }
    if (version(fstatSync(fd, { bigint: true })) !== stamp) throw Error('Changed installation record')
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { closeSync(fd) }
  const verify = () => { verifyNativePathFacts(facts); if (version(lstatSync(file, { bigint: true })) !== stamp) throw Error('Changed installation record') }
  verify()
  return { text, file, stamp, facts, verify }
}

/** The helper records this one installation after core dies. Its shell has job control off,
 * so the deadline kills the installer group, including stopped children. It never runs an engine. */
export const NATIVE_INSTALL_WORKER = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
const [file,expected,testDeadline]=process.argv.slice(1),directory=path.dirname(file),C=fs.constants;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const id=s=>String(s.dev)+':'+String(s.ino)+':'+String(s.mode)+':'+String(s.uid);
const ver=s=>id(s)+':'+String(s.size)+':'+String(s.mtimeNs)+':'+String(s.ctimeNs);
const nodev=s=>s&&s.slice(s.indexOf(':')+1);
function read(file){const fd=fs.openSync(file,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{
 const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile()||s.size>262144n||s.uid!==BigInt(process.getuid())||(s.mode&0o022n))throw Error('Unsafe installation record');
 const bytes=Buffer.alloc(Number(s.size));let offset=0;for(let calls=0;offset<bytes.length;calls++){
  if(calls>=64)throw Error('Installation record read limit');const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('Truncated record');offset+=n}
 if(ver(fs.fstatSync(fd,{bigint:true}))!==ver(s)||ver(fs.lstatSync(file,{bigint:true}))!==ver(s))throw Error('Changed installation record');
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 }finally{fs.closeSync(fd)}}
const directoryFd=fs.openSync(directory,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW),directoryId=id(fs.fstatSync(directoryFd,{bigint:true}));
const text=read(file);if(hash(text)!==expected)throw Error('Changed installation claim');
const claim=JSON.parse(text),authorityText=read(claim.authority),authority=JSON.parse(authorityText),dispatchText=read(claim.witness),dispatch=JSON.parse(dispatchText);
if(nodev(authority.directory)!==nodev(directoryId)||read(file+'.dispatch')!==dispatchText||dispatch.kind!=='run'||dispatch.token!==claim.token||dispatch.claim!==expected)throw Error('Unconfirmed installer dispatch');
try{fs.lstatSync(file+'.result');throw Error('Installer already settled')}catch(e){if(e.code!=='ENOENT')throw e}
function current(){
 if(id(fs.lstatSync(directory,{bigint:true}))!==directoryId||read(file)!==text||read(claim.authority)!==authorityText||read(claim.witness)!==dispatchText||read(file+'.dispatch')!==dispatchText)throw Error('Changed installation authority');
 for(const p of claim.previous)if(hash(read(p.file))!==p.digest)throw Error('Changed installation predecessor');
 for(const r of claim.routes){let s;try{s=fs.lstatSync(r.path,{bigint:true})}catch(e){if(e.code!=='ENOENT')throw e;s=null}
  if(nodev(s?id(s):null)!==nodev(r.identity))throw Error('Changed installation target');
  if(r.alias&&(!s||nodev(ver(s))!==nodev(r.alias.version)||fs.readlinkSync(r.path)!==r.alias.target))throw Error('Changed installation alias');}
}
function publish(value){
 current();const temporary=file+'.'+claim.token+'.result-tmp',result=file+'.result';
 const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>262144)throw Error('Oversized installation result');
 const fd=fs.openSync(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
 try{
  fs.writeFileSync(fd,bytes);const staged=ver(fs.fstatSync(fd,{bigint:true}));fs.fsyncSync(fd);
  if(ver(fs.fstatSync(fd,{bigint:true}))!==staged||ver(fs.lstatSync(temporary,{bigint:true}))!==staged)throw Error('Changed result staging file');
  current();fs.linkSync(temporary,result);
  if(id(fs.lstatSync(result,{bigint:true}))!==id(fs.fstatSync(fd,{bigint:true}))||read(result)!==bytes)throw Error('Changed published result');
  if(id(fs.lstatSync(temporary,{bigint:true}))!==id(fs.fstatSync(fd,{bigint:true})))throw Error('Changed result staging file');
  fs.unlinkSync(temporary);if(process.platform!=='win32')fs.fsyncSync(directoryFd);
  if(id(fs.lstatSync(result,{bigint:true}))!==id(fs.fstatSync(fd,{bigint:true}))||read(result)!==bytes)throw Error('Changed confirmed result');
 }finally{fs.closeSync(fd)}
}
current();
let output='',finished=false,leaderGone=false,uncertain=false,deadline,drain;
const environment={...process.env};for(const key of ${JSON.stringify(LAUNCH_LOCATION_VARIABLES)})delete environment[key];Object.assign(environment,claim.environment);
const child=cp.spawn(claim.argv[0],claim.argv.slice(1),{env:environment,cwd:claim.environment.HOME,detached:true,stdio:['ignore','pipe','pipe']});
const collect=chunk=>{output=(output+chunk.toString()).slice(-32768)};
child.stdout.on('data',collect);child.stderr.on('data',collect);
child.on('error',error=>{output=String(error).slice(0,2000)});
child.on('exit',()=>{
 leaderGone=true;clearTimeout(deadline);
 drain=setTimeout(()=>{if(finished)return;uncertain=true;child.stdout.destroy();child.stderr.destroy()},250);
});
child.on('close',(code,signal)=>{if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(drain);try{if(!uncertain)publish({token:claim.token,claim:expected,code,signal,detail:output})}finally{fs.closeSync(directoryFd)}});
deadline=setTimeout(()=>{if(leaderGone||child.exitCode!==null||child.signalCode!==null)return;try{process.kill(-child.pid,'SIGKILL')}catch{}},Math.max(20,Math.min(1200000,Number(testDeadline)||1200000)));
`

export function createNativeInstallations({ directory, node = managedNodePath, dispatch = defaultDispatch, platform = process.platform }: {
  directory: string; node?: () => string; dispatch?: (node: string, file: string, digest: string) => void; platform?: NodeJS.Platform
}) {
  // Outside the claim directory: recreating or emptying that directory cannot erase its active owner.
  const authorityFile = `${directory}.authority`
  const examine = async (engine: AgentEngine, inputRecipe: EngineInstallRecipe, inputEnvironment: Record<string, string>, request: string,
    current: () => boolean, query = false): Promise<NativeInstallation | null> => {
    // Windows: the evidence below walks POSIX paths only (NativePaths), so every read threw there and every create, a
    // terminal's too, held at "Waiting to confirm durable engine installation ownership" (the Windows VM E2E,
    // 2026-10-15). Installing an engine first is not carried on Windows yet (sub-project B), so no history is ever
    // written there: a query has nothing to report, and a launch that needs an install waits with that reason.
    if (platform === 'win32') return query ? null : hold(`${engine} is not installed. Installing engines is not supported on Windows yet: install it, then try again.`)
    try {
      if (!current()) return hold('The saved launch request changed before installation.')
      // Snapshot caller-owned objects before any yield. The fingerprint and executed bytes agree.
      const recipe = structuredClone(inputRecipe), environment = { ...inputEnvironment }, runtime = query ? '' : node()
      if (!isAbsolute(directory) || typeof request !== 'string' || !request || request.length > 4096
        || (!query && (!isAbsolute(environment.HOME ?? '') || !isAbsolute(runtime)
          || Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
          || typeof recipe.command !== 'string' || recipe.command.includes('\0')))) throw Error('Invalid installation input')
      const wantedRecipe = digest(JSON.stringify({ recipe, environment }))
      const argv = query ? [] : buildEngineInstallationArgv(engine, recipe, environment, runtime)
      // Enforce the helper's read limit before publishing any irreversible claim.
      if (Buffer.byteLength(JSON.stringify({ recipe, environment, argv })) > LIMIT - 32768) throw Error('Oversized installation input')
      const maybe = (file: string) => {
        try { return readRecord(file) } catch (error) { if (!missing(error)) throw error; return undefined }
      }
      const witness = (index: number) => `${directory}.${String(index).padStart(8, '0')}.dispatch`
      let authority = maybe(authorityFile)
      if (!authority && maybe(witness(0))) return hold('The engine installation authority is missing; previous work cannot be replayed.')
      if (query && !authority) {
        const absent = new NativeFiles()
        if (absent.entries(directory, true).length) return hold('The engine installation authority is missing; existing work cannot be replayed.')
        absent.verify()
        if (!current() || maybe(authorityFile) || maybe(witness(0))) return hold('Waiting to confirm current installation ownership.')
        return null
      }
      secureStateDirectory(directory, !authority)
      const paths = new NativePaths(new NativeEvidenceBudget())
      paths.resolveSync(directory)
      const directoryFacts = paths.snapshot(), directoryId = identity(lstatSync(directory, { bigint: true }))
      const physical = () => { try { verifyNativePathFacts(directoryFacts); return true } catch { return false } }
      const publish = async (file: string, bytes: string, owner = physical) => {
        if (Buffer.byteLength(bytes) > LIMIT) throw Error('Oversized installation record')
        return runHookPreparation([file], attempt => inspectHookFile(file, 0o600).replace(bytes, attempt, true), { current: owner, retainConflicts: true })
      }
      const confirm = async (file: string, record: ReturnType<typeof readRecord>, owner = physical) => {
        await runHookPreparation([file], attempt => {
          record.verify()
          const observed = inspectHookFile(file, 0o600)
          if (observed.content !== record.text) throw Error('Changed installation confirmation')
          record.verify()
          // Equal bytes take only the fsync path; confirmation can never overwrite newer evidence.
          return observed.replace(record.text, attempt)
        }, { current: owner, retainConflicts: true })
        record.verify()
      }
      if (!authority) {
        if (new NativeFiles().entries(directory).length) return hold('The engine installation authority is missing; existing work cannot be replayed.')
        await publish(authorityFile, JSON.stringify({ version: 1, directory: directoryId } satisfies Authority))
        authority = readRecord(authorityFile)
      }
      const genesis = JSON.parse(authority.text) as Authority
      if (genesis.version !== 1 || withoutDevice(genesis.directory) !== withoutDevice(directoryId)) return hold('The engine installation history was replaced; its previous owner is still unconfirmed.')
      const stamp = directoryStamp(directory)
      // NativeFiles retains iterator acquisition and ancestor evidence, including ABA route swaps.
      const entries = new NativeFiles().entries(directory), names = entries.filter(name => /^\d{8}\.json$/.test(name)).sort()
      if (names.length > MAX_INSTALLATIONS) return hold('The engine installation history exceeds the automatic recovery limit. Its saved records need review before another installation.')
      if (maybe(witness(names.length)) || entries.some(name => /^\d{8}\.json\.(result|dispatch)$/.test(name) && !names.includes(name.replace(/\.(result|dispatch)$/, '')))) {
        return hold('The engine installation history is incomplete; a previous installation may still own its target.')
      }
      const previous: Link[] = []
      const routesByPath = new Map<string, NativePathFact>(), leaves = new Map<string, string>()
      const retain = (record: ReturnType<typeof readRecord>) => {
        for (const fact of record.facts) {
          if (fact.path === record.file) continue // The leaf's complete version is checked below.
          const prior = routesByPath.get(fact.path)
          if (prior && JSON.stringify(prior) !== JSON.stringify(fact)) throw Error('Changed installation ancestry')
          routesByPath.set(fact.path, fact)
        }
        const prior = leaves.get(record.file)
        if (prior && prior !== record.stamp) throw Error('Changed installation record')
        leaves.set(record.file, record.stamp)
      }
      retain(authority)
      let complete = false, began = performance.now()
      let pending: { file: string; record: ReturnType<typeof readRecord>; claim: Claim; slot?: ReturnType<typeof readRecord> } | undefined
      let lastResult: { file: string; record: ReturnType<typeof readRecord> } | undefined
      for (const [index, name] of names.entries()) {
        if (name !== `${String(index).padStart(8, '0')}.json`) return hold('The engine installation history has an unconfirmed gap.')
        const file = join(directory, name), record = readRecord(file), hash = digest(record.text), claim = JSON.parse(record.text) as Claim
        retain(record)
        if (claim.version !== 1 || typeof claim.token !== 'string' || !claim.token || typeof claim.request !== 'string'
          || claim.authority !== authorityFile || claim.witness !== witness(index) || JSON.stringify(claim.previous) !== JSON.stringify(previous)) throw Error('Invalid installation claim')
        if (claim.request === request && (claim.engine !== engine || (!query && claim.recipe !== wantedRecipe))) return hold('The saved request’s installation choices changed.')
        const resultRecord = maybe(`${file}.result`), slot = maybe(claim.witness)
        if (slot) retain(slot)
        if (!resultRecord) {
          if (index !== names.length - 1) throw Error('Unfinished installation predecessor')
          pending = { file, record, claim, slot }; break
        }
        if (!slot) throw Error('Missing installation dispatch witness')
        const markerRecord = readRecord(`${file}.dispatch`)
        retain(markerRecord); retain(resultRecord)
        const result = JSON.parse(resultRecord.text) as Result, marker = JSON.parse(slot.text) as Dispatch
        if (markerRecord.text !== slot.text || marker.token !== claim.token || marker.claim !== hash || !['run', 'cancelled'].includes(marker.kind)
          || result.token !== claim.token || result.claim !== hash || (result.code !== null && !Number.isInteger(result.code))
          || (result.signal !== null && (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(result.signal)))
          || (result.notDispatched !== true && (result.code === null) === (result.signal === null))
          || (result.notDispatched !== undefined && (result.notDispatched !== true || result.code !== null || result.signal !== null))
          || (marker.kind === 'cancelled' && result.notDispatched !== true)) throw Error('Invalid installation result')
        // A settled failure is certain, not an uncertain dispatch. This request's own is never run again: its
        // launch is refused with the installer's words. Another request's no longer holds every later launch of
        // the engine, as it did with nothing that could release it: a person asking again is a new attempt, with
        // an installer of its own (a fresh Ubuntu VM, 2026-10-12, where one failed install would have ended
        // every later `harness new` of that engine).
        if (claim.request === request && !result.notDispatched) {
          if (result.code !== 0 || result.signal !== null) {
            return { complete: false, failed: true, detail: failureReason(typeof result.detail === 'string' ? result.detail : '',
              result.signal ? `its installer was stopped (${result.signal})` : `its installer exited with status ${result.code}`) }
          }
          complete = true
        }
        lastResult = { file: `${file}.result`, record: resultRecord }
        previous.splice(0, previous.length, { file, digest: hash }, { file: `${file}.result`, digest: digest(resultRecord.text) })
        if (performance.now() - began > 20) { await new Promise<void>(done => setImmediate(done)); began = performance.now() }
      }
      const historyOwner = () => {
        try {
          const began = performance.now()
          verifyNativePathFacts([...routesByPath.values()])
          for (const [file, stamp] of leaves) {
            if (performance.now() - began > 20 || version(lstatSync(file, { bigint: true })) !== stamp) return false
          }
          return physical()
        } catch { return false }
      }
      const historyCurrent = () => historyOwner() && directoryStamp(directory) === stamp
      if (!current() || !historyCurrent()) return hold('Waiting to confirm current installation ownership.')
      // A helper may have linked its result just before its final directory sync failed.
      if (lastResult) await confirm(lastResult.file, lastResult.record, historyCurrent)
      if (!current() || !historyCurrent()) return hold('Waiting to confirm current installation ownership.')
      if (pending?.slot) {
        const { file, record, claim, slot } = pending
        const marker = JSON.parse(slot.text) as Dispatch, hash = digest(record.text)
        if (marker.token !== claim.token || marker.claim !== hash || !['run', 'cancelled'].includes(marker.kind)) throw Error('Invalid pending installer dispatch')
        if (marker.kind === 'cancelled') {
          // A durable cancellation proves the helper never ran. Complete only
          // that result, including when a ready executable takes the status path.
          const retained = () => {
            try { record.verify(); slot.verify(); verifyNativePathFacts(claim.routes); return historyOwner() }
            catch { return false }
          }
          const inside = maybe(`${file}.dispatch`)
          if (inside) {
            if (inside.text !== slot.text) throw Error('Changed cancellation marker')
            await confirm(`${file}.dispatch`, inside, retained)
          } else await publish(`${file}.dispatch`, slot.text, retained)
          await confirm(claim.witness, slot, retained)
          await publish(`${file}.result`, JSON.stringify({ token: claim.token, claim: hash, code: null, signal: null, notDispatched: true } satisfies Result), retained)
          return hold('The cancelled installer is settled; the saved launch can retry.')
        }
      }
      if (complete && !pending) return { complete: true }
      if (query) return pending && (pending.claim.engine === engine || pending.claim.request === request)
        ? installing(pending.slot, 'Waiting for the saved installer to settle. An executable appearing before completion is not installation authority.')
        : complete ? { complete: true } : null
      if (!pending && names.length >= MAX_INSTALLATIONS) return hold('The engine installation history is full. Its saved records need review before another installation.')
      // HOME gets a fresh budget after history enumeration and yields.
      const homes = new NativePaths(new NativeEvidenceBudget()), home = homes.resolveSync(environment.HOME)
      if (!home?.info.isDirectory()) return hold('Waiting to confirm the native installation home.')
      const routes = [...directoryFacts, ...homes.snapshot()]
      const file = pending?.file ?? join(directory, `${String(names.length).padStart(8, '0')}.json`)
      const claim: Claim = pending?.claim ?? { version: 1, token: randomUUID(), request, engine, recipe: wantedRecipe,
        argv, environment, routes, previous, authority: authorityFile, witness: witness(names.length) }
      const bytes = pending?.record.text ?? JSON.stringify(claim), hash = digest(bytes)
      verifyNativePathFacts(claim.routes)
      if (!current() || !historyCurrent()) return hold('Waiting to confirm current installation ownership.')
      if (pending) await confirm(file, pending.record, historyCurrent)
      else await publish(file, bytes, historyOwner)
      const claimed = readRecord(file)
      const claimCurrent = () => { try { authority!.verify(); claimed.verify(); verifyNativePathFacts(claim.routes); return physical() } catch { return false } }
      const result = JSON.stringify({ token: claim.token, claim: hash, code: null, signal: null, notDispatched: true } satisfies Result)
      if (pending?.slot) {
        return installing(pending.slot, 'Waiting for the dispatched installer result. An uncertain dispatch is never repeated.')
      }
      // A missing outside witness with an inside sentinel is a lost history, not a new dispatch.
      if (maybe(`${file}.dispatch`)) return hold('The installer dispatch witness is missing; its previous worker may still own the installation.')
      if (!claimCurrent()) return hold('Waiting to confirm the installer claim.')
      // Another request may settle an inert reservation, but cannot replay or cancel an actual installer.
      const kind = current() && claim.request === request ? 'run' : 'cancelled'
      const markerBytes = JSON.stringify({ token: claim.token, claim: hash, kind } satisfies Dispatch)
      await publish(claim.witness, markerBytes, claimCurrent)
      const slot = readRecord(claim.witness)
      const dispatchCurrent = () => { try { slot.verify(); return claimCurrent() } catch { return false } }
      await publish(`${file}.dispatch`, markerBytes, dispatchCurrent)
      if (kind === 'cancelled' || !current()) {
        await publish(`${file}.result`, result, dispatchCurrent)
        return hold('The launch changed before installation. No installer was dispatched.')
      }
      if (!dispatchCurrent()) return hold('Waiting to confirm the installer claim.')
      dispatch(runtime, file, hash)
      return running('Installing the required engine. The saved launch continues after installation is confirmed.')
    } catch (error) {
      // Any failed check lands here, and the person sees only this line. Without the reason in the log, a hold
      // that never cleared could only be traced by hand over many round trips with the user (2026-10-19).
      console.warn(`[native-install] ${engine} held:`, error instanceof Error ? error.message : error)
      return hold('Waiting to confirm durable engine installation ownership.')
    }
  }
  const ensure = async (engine: AgentEngine, recipe: EngineInstallRecipe, environment: Record<string, string>, request: string, current: () => boolean): Promise<NativeInstallation> =>
    (await examine(engine, recipe, environment, request, current))!
  const status = (engine: AgentEngine, request: string, current: () => boolean) => examine(engine,
    { command: '', source: '', executable: { names: [] } }, {}, request, current, true)
  return { ensure, status }
}

function defaultDispatch(node: string, file: string, hash: string): void {
  const child = spawn(node, ['-e', NATIVE_INSTALL_WORKER, file, hash], { detached: true, stdio: 'ignore' })
  child.on('error', () => { /* The durable dispatch stays uncertain; it never authorizes a replay. */ })
  child.unref()
}
