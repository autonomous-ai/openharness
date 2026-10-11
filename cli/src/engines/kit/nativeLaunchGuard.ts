/** A final check after login rc files, immediately before the prepared command. */
import type { NativeLaunch } from '../nativeLaunch.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'

/** JSON is passed as one literal argv. Nothing from a path is parsed as code. */
export function nativeLaunchGuard(launch: NativeLaunch, node: string, held: string): string {
  if (!launch.executable) return ''
  const proof = { ready: launch.ready?.() !== false, command: launch.executable.command, identity: launch.executable.identity,
    files: launch.proofs.flatMap(item => item.files) }
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
