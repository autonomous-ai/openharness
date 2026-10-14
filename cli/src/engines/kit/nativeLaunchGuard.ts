/** A final check after login rc files, immediately before the prepared command. */
import type { NativeLaunch } from '../nativeLaunch.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { verifyNativePathFacts } from './nativePaths.js'
import type { HookPreparationProof } from './nativeHookFiles.js'

export interface NativeLaunchProof {
  ready: boolean
  command: string
  identity: string
  files: HookPreparationProof['files'][number][]
}

export function nativeLaunchProof(launch: NativeLaunch): NativeLaunchProof {
  if (!launch.executable) return nativeUnavailable('the prepared native executable is unavailable')
  return { ready: launch.ready?.() !== false, command: launch.executable.command, identity: launch.executable.identity,
    files: launch.proofs.flatMap(item => item.files) }
}

/** The asynchronous witness retains the same serialized dependency image as
 * the post-rc guard. It must not recapture files after its native process wait. */
export function verifyNativeLaunchProof(proof: NativeLaunchProof, budget: NativeEvidenceBudget): void {
  const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && value.length <= 4096
  if (!proof || proof.ready !== true || !path(proof.command) || typeof proof.identity !== 'string' || proof.identity.length > 16384
    || !Array.isArray(proof.files) || proof.files.length > 128) return nativeUnavailable('the prepared native dependency proof is incomplete')
  budget.step()
  const info = statSync(proof.command, { bigint: true })
  if (`${proof.command}:${realpathSync(proof.command)}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== proof.identity) {
    return nativeUnavailable('the prepared native executable changed')
  }
  for (const file of proof.files) {
    budget.step()
    if (!file || !path(file.file) || !path(file.target) || !Array.isArray(file.facts)
      || file.stamp !== null && typeof file.stamp !== 'string') return nativeUnavailable('a prepared native dependency is incomplete')
    verifyNativePathFacts(file.facts)
    let current: string | null
    try {
      const info = lstatSync(file.target, { bigint: true })
      current = `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current = null }
    if (current !== file.stamp) return nativeUnavailable('a prepared native dependency changed')
  }
  budget.step()
}

/** JSON is passed as one literal argv. Nothing from a path is parsed as code. */
export function nativeLaunchGuard(launch: NativeLaunch, node: string, held: string): string {
  if (!launch.executable) return ''
  const proof = nativeLaunchProof(launch)
  const verify = [
    'const fs=require("node:fs"),p=JSON.parse(process.argv[1]);',
    'const id=s=>`${s.dev}:${s.ino}:${s.mode}:${s.uid}`;',
    'const ver=s=>`${id(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;',
    'const stamp=s=>`${s.dev}:${s.ino}:${s.uid}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;',
    'const stat=p=>{try{return fs.lstatSync(p,{bigint:true})}catch(e){if(e.code==="ENOENT")return null;throw e}};',
    'try{if(!p.ready)throw 0;const s=fs.statSync(p.command,{bigint:true});',
    'if(`${p.command}:${fs.realpathSync(p.command)}:${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`!==p.identity)throw 0;',
    'for(const f of p.files){for(const r of f.facts){const s=stat(r.path);',
    'if((s?id(s):null)!==r.identity)throw 0;',
    'if(r.alias&&(!s||ver(s)!==r.alias.version||fs.readlinkSync(r.path)!==r.alias.target))throw 0;}',
    'const s=stat(f.target);if((s?stamp(s):null)!==f.stamp)throw 0;}',
    '}catch{process.exitCode=75}',
  ].join('')
  return `if ! ${shellSingleQuote(node)} -e ${shellSingleQuote(verify)} ${shellSingleQuote(JSON.stringify(proof))}; then\n${held}\nfi\n`
}
