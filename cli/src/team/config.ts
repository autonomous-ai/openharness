/**
 * What setup made, written root-owned to /Library/Application Support/Harness/team.json (on Linux /etc/harness/team.json,
 * on Windows C:\ProgramData\Harness\team.json). Setup and `harness team` were removed on 2026-11-10; the file stays on
 * computers set up before, until the person removes the account (Desktop asks), and names what is to go. Nothing in it is
 * secret: names and paths. On Linux `label` and `plist` name the systemd unit and its file.
 */
import { readFileSync } from 'node:fs'
import { TEAM_CONFIG_FILE, TEAM_CONFIG_FILES, carriedBackendEnv, checkPort, pathCheck, userCheck } from './layout.js'
import { checkSid } from '../lib/windows/sid.js'

export interface TeamConfig {
  version: 1
  /** The team account's short name, and its home. */
  user: string
  realName: string
  home: string
  /** The Mac's owner, whose files the team account must not reach, and their home. */
  owner: string
  ownerHome: string
  /** Windows: the owner's SID, read by the owner's own process before User Account Control, which may run setup as
   *  another administrator. It names the owner in the handover folder's ACL. */
  ownerSid?: string
  /** The world-readable file in the owner's home that only the home folder's mode protects. */
  sentinel: string
  port: number
  label: string
  plist: string
  statusFile: string
  /** The team account's Node and CLI. */
  node: string
  cli: string
  /** The backend settings carried from the owner's environment (./layout.ts `carriedBackendEnv`), which the team
   *  daemon runs with. */
  env: Record<string, string>
  createdAt: string
}

/** Where setup wrote the Team config on [platform]: the one place every reader looks. */
export function teamConfigFile(platform: NodeJS.Platform = process.platform): string {
  return Object.hasOwn(TEAM_CONFIG_FILES, platform) ? TEAM_CONFIG_FILES[platform as keyof typeof TEAM_CONFIG_FILES] : TEAM_CONFIG_FILE
}

/** The config at [path] (this platform's, by default), every field checked; null when there is none or it is not one
 *  setup wrote. */
export function readTeamConfig(path: string = teamConfigFile(),
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'), platform: NodeJS.Platform = process.platform): TeamConfig | null {
  // Windows' names and paths on Windows (`DELL`, `C:\Users\DELL`), the POSIX ones elsewhere.
  const checkUser = userCheck(platform)
  const checkPath = pathCheck(platform)
  let raw: unknown
  try { raw = JSON.parse(read(path)) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  try {
    const text = (key: string): string => {
      const v = value[key]
      if (typeof v !== 'string' || !v) throw new Error(key)
      return v
    }
    if (value.version !== 1 || typeof value.port !== 'number') return null
    return {
      version: 1,
      user: checkUser(text('user')),
      realName: text('realName').slice(0, 80),
      home: checkPath(text('home')),
      owner: checkUser(text('owner')),
      ownerHome: checkPath(text('ownerHome')),
      ...platform === 'win32' ? { ownerSid: checkSid(text('ownerSid')) } : {},
      sentinel: checkPath(text('sentinel')),
      port: checkPort(value.port),
      label: text('label'),
      plist: checkPath(text('plist')),
      statusFile: checkPath(text('statusFile')),
      node: checkPath(text('node')),
      cli: checkPath(text('cli')),
      env: carriedBackendEnv(value.env && typeof value.env === 'object' ? value.env as NodeJS.ProcessEnv : {}),
      createdAt: text('createdAt'),
    }
  } catch {
    return null
  }
}
