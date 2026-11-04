/**
 * The Windows boundary of the Harness Team account, as far as it can be checked without Windows (security pass of task #2022,
 * docs/security/2026-11-02-team-account-windows.md). Nothing here creates a user, changes an ACL or opens a port.
 *
 * - What each account may do in the folders the elevated setup script makes, read from the security descriptors it writes
 *   and decoded bit by bit: the team account adds nothing to the sign-in handover folder and cannot remove it, and no other
 *   account reads the code or the relay's token.
 * - The owner's local credential over TCP on Windows (finding W1, fixed): no client puts it on a TCP request, and the daemon
 *   counts it from no other account.
 * - The connectors bridge's port on Windows (task #2162, from Reed's review of W1): another account holding it is told apart
 *   from this account's own listener, so the bridge moves off it.
 */
import { mkdtempSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateHookCredential } from '../lib/hookAuth.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { peerIsThisAccount, portHolderIsThisAccount } from '../lib/peerAccount.js'
import { buildWindowsSetupScript, type WindowsSetupScriptInput } from './windowsScript.js'

const OWNER_HOME = 'C:\\Users\\owner-placeholder'
const NODE_DIR = `${OWNER_HOME}\\.harness\\runtime\\node-v22.23.2-win32-x64`
const input: WindowsSetupScriptInput = {
  user: 'harnessteam', realName: 'Harness Team', home: 'C:\\Users\\harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME,
  ownerSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001', stageDir: `${OWNER_HOME}\\AppData\\Local\\Temp\\harness-team-x1`,
  nodeRuntimeDir: NODE_DIR, tmuxRuntimeDir: null, cliDir: `${OWNER_HOME}\\.harness\\cli\\0.4.97`, ownerNode: `${NODE_DIR}\\node.exe`,
  ownerCli: `${OWNER_HOME}\\.harness\\cli\\0.4.97\\cli.js`, mintEnv: {}, signIn: 'missing',
}
const script = buildWindowsSetupScript(input)

// File and folder rights, as an access mask holds them (winnt.h).
const RIGHT = {
  readOrList: 0x1, writeOrAddFile: 0x2, appendOrAddFolder: 0x4, writeEa: 0x10, deleteChild: 0x40, writeAttributes: 0x100,
  delete: 0x10000, writeDac: 0x40000, writeOwner: 0x80000, genericAll: 0x10000000, genericWrite: 0x40000000,
} as const
/** Every right that changes a folder, a file in it, or who may: what "read only" must hold none of. */
const CHANGES = RIGHT.writeOrAddFile | RIGHT.appendOrAddFolder | RIGHT.writeEa | RIGHT.deleteChild | RIGHT.writeAttributes
  | RIGHT.delete | RIGHT.writeDac | RIGHT.writeOwner | RIGHT.genericAll | RIGHT.genericWrite
const FULL = 0x1f01ff

/** A mask as the script writes one: `FA`, or a number in hex. Any other name throws rather than read as no rights. */
function maskOf(mask: string): number {
  if (mask === 'FA') return FULL
  if (/^0x[0-9a-f]{1,8}$/i.test(mask)) return Number(mask)
  throw new Error(`a mask this decoder cannot read: ${mask}`)
}

interface Ace { sid: string; mask: number; onFolder: boolean; onChildren: boolean }

/** The allow ACEs of an SDDL string, whether its DACL is protected, and each ACE's mask and where it applies. */
function dacl(sddl: string): { protected: boolean; aces: Ace[] } {
  const body = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl)
  if (!body) throw new Error(`no DACL in ${sddl}`)
  const aces = [...body[2]!.matchAll(/\(([^)]*)\)/g)].map((match) => {
    const [type, flags, mask, , , sid] = match[1]!.split(';')
    if (type !== 'A') throw new Error(`not an allow ACE: ${match[0]}`)
    const inherits = /OI|CI/.test(flags!)
    return { sid: sid!, mask: maskOf(mask!), onFolder: !flags!.includes('IO'), onChildren: inherits }
  })
  return { protected: body[1]!.includes('P'), aces }
}

/** The SDDL the script gives a folder, by the line that makes it. */
function sddlOf(line: RegExp): string {
  const found = line.exec(script)
  if (!found) throw new Error(`the setup script has no ${line}`)
  return found[1]!
}

const OWNER = '$OWNER_SID', TEAM = '$teamSid', SYSTEM = 'SY', ADMINS = 'BA'
/** Each account named, so none other can come in unseen: Users, Authenticated Users, Everyone. */
const ONLY = (aces: Ace[]) => [...new Set(aces.map((ace) => ace.sid))].sort()
const rights = (aces: Ace[], sid: string, where: 'folder' | 'children'): number =>
  aces.filter((ace) => ace.sid === sid && (where === 'folder' ? ace.onFolder : ace.onChildren)).reduce((all, ace) => all | ace.mask, 0)

describe('the decoder these tests read the ACLs with', () => {
  // Number('GW') is NaN, and NaN & anything is 0: a named mask read as no rights at all (security review 1 of #2568).
  it('refuses a mask it cannot read, and counts generic write and generic all as changes', () => {
    for (const named of ['GW', 'GA', 'FW', 'RC']) expect(() => dacl(`D:P(A;;${named};;;BU)`), named).toThrow()
    for (const generic of ['0x40000000', '0x10000000']) expect(dacl(`D:P(A;;${generic};;;BU)`).aces[0]!.mask & CHANGES, generic).not.toBe(0)
  })
})

describe('the folders the Windows setup script makes, by what each account may do there', () => {
  it('the sign-in handover: the owner adds the code, the team account reads and deletes it, nobody else sees it', () => {
    const { protected: closed, aces } = dacl(sddlOf(/Set-Folder \$HANDOFF_DIR "([^"]+)"/))
    // Protected: the status folder's Users read is not inherited, so no other account reads a code in its 90 seconds.
    expect(closed).toBe(true)
    expect(ONLY(aces)).toEqual([OWNER, TEAM, ADMINS, SYSTEM].sort())
    expect(rights(aces, OWNER, 'folder') & RIGHT.writeOrAddFile).toBe(RIGHT.writeOrAddFile)
    // The team account adds no file or folder (no planted code, link or junction) and cannot remove, rename or re-ACL it.
    expect(rights(aces, TEAM, 'folder') & CHANGES).toBe(0)
    // On the code: read it, delete it (with write-attributes, which Node's unlink needs), never change what it says.
    expect(rights(aces, TEAM, 'children') & (RIGHT.writeOrAddFile | RIGHT.appendOrAddFolder | RIGHT.writeDac | RIGHT.writeOwner)).toBe(0)
    expect(rights(aces, TEAM, 'children') & (RIGHT.readOrList | RIGHT.delete)).toBe(RIGHT.readOrList | RIGHT.delete)
  })

  it('the status folder: the team account writes its status, but cannot delete what it did not make, nor change who may', () => {
    const { protected: closed, aces } = dacl(sddlOf(/Set-Folder \$STATUS_DIR "([^"]+)"/))
    expect(closed).toBe(true)
    expect(ONLY(aces)).toEqual([TEAM, ADMINS, SYSTEM, 'BU'].sort())
    // No delete-child: the handover folder setup made in it stays, whatever the team account does.
    expect(rights(aces, TEAM, 'folder') & (RIGHT.deleteChild | RIGHT.writeDac | RIGHT.writeOwner)).toBe(0)
    // Every account reads the status (the owner's `harness team status`), and changes nothing in it.
    expect(rights(aces, 'BU', 'folder') & CHANGES).toBe(0)
    expect(rights(aces, 'BU', 'children') & CHANGES).toBe(0)
  })

  it('the relay folder: the owner\'s, the team account reads the grant, nobody else is named', () => {
    const { protected: closed, aces } = dacl(sddlOf(/SetSecurityDescriptorSddlForm\("(D:P[^"]+)", 'Access'\)/))
    expect(closed).toBe(true)
    expect(ONLY(aces)).toEqual([OWNER, TEAM, ADMINS, SYSTEM].sort())
    expect(rights(aces, TEAM, 'folder') & CHANGES).toBe(0)
    expect(rights(aces, TEAM, 'children') & CHANGES).toBe(0)
  })

  it('the shared folder and this run\'s stage: Administrators\' and SYSTEM\'s, read by the rest', () => {
    for (const line of [/Set-Folder \$SHARED "([^"]+)"/, /\$RT = New-Stage "([^"]+)"/]) {
      const { protected: closed, aces } = dacl(sddlOf(line))
      expect(closed, String(line)).toBe(true)
      for (const ace of aces.filter((a) => a.sid !== ADMINS && a.sid !== SYSTEM)) expect(ace.mask & CHANGES, `${line} ${ace.sid}`).toBe(0)
    }
  })
})

describe('W1: the owner\'s local credential never goes over TCP on Windows', () => {
  it('a client puts no credential on a loopback TCP request, on Windows as on macOS and Linux', () => {
    const data = mkdtempSync(join(tmpdir(), 'team-win-boundary-'))
    loadOrCreateHookCredential(data)
    expect(localCredentialHeaders(data, 'darwin')).toEqual({})
    expect(localCredentialHeaders(data, 'win32')).toEqual({})
  })

  it('the daemon counts it only from this account: Windows is asked who is calling, and another account is refused', async () => {
    const stranger = { remoteAddress: '127.0.0.1', remotePort: 50_001, localAddress: '127.0.0.1', localPort: 18473 } as Socket
    await expect(peerIsThisAccount(stranger, 'win32', async () => ({ status: 0, stdout: 'no\r\n' }))).resolves.toBe(false)
  })
})

describe('the connectors bridge\'s port on Windows (task #2162)', () => {
  // Windows answered null, so the bridge never moved: the Team account, holding 51793 from boot, kept hearing the owner's
  // agents' tool calls and could answer them falsely. Now Windows is asked whose the listener is.
  it('another account holding the bridge\'s port is told apart from this account\'s own, so the bridge moves off it', async () => {
    await expect(portHolderIsThisAccount(51793, 'win32', async () => ({ status: 0, stdout: 'no\r\n' }))).resolves.toBe(false)
    await expect(portHolderIsThisAccount(51793, 'win32', async () => ({ status: 0, stdout: 'yes\r\n' }))).resolves.toBe(true)
  })
})
