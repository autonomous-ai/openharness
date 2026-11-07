import { describe, expect, it } from 'vitest'
import { failureNotice, MACHINE_FAILED, publicReason } from './startFailure.js'

// Task #3861 (River, 11-06): five starts failed on four machines in a day and their notices said only "could not prepare or launch
// it". A host's words can name a machine, a folder or a token (publicReason), so only the fixed shapes this CLI writes for a fault of
// the machine itself are told, and never anything a host adds to them.
describe('what a group member reads of a fault of the machine', () => {
  const folder = '~/.harness/cli/data/agent-creations'
  const storage = (path = folder) => `CREATION_STORAGE_FAILED: The creation folder ${path} is not usable by this account (permissions). It must belong to this account with mode 700; the owner of this computer fixes that, Harness does not change it.`

  it('tells the unusable creation folder and that its owner fixes it', () => {
    expect(publicReason(storage())).toBe(`Its machine's creation folder ${folder} is not usable by its account (permissions): the owner of that computer fixes its owner and mode.`)
    expect(failureNotice('Heron', storage(), undefined)).toContain('creation folder ~/.harness/cli/data/agent-creations is not usable')
  })
  it('tells a clone that stopped, without the words git added', () => {
    const clone = "This machine could not clone the project repository with the Harness GitHub App's token: Cloning stopped making progress (git's last words: fatal: unable to access 'https://x-access-token:SECRET@github.com/o/r.git'). Check the connection and retry."
    expect(publicReason(clone)).toBe("Its machine could not clone the project repository with the Harness GitHub App's token.")
    expect(publicReason(clone)).not.toContain('SECRET')
  })
  it('tells nothing else a host wrote: a path outside the home folder, or anything appended', () => {
    expect(publicReason(storage('/Users/stone/.harness/cli/data/agent-creations'))).toBe(MACHINE_FAILED)
    expect(publicReason(`${storage()} token=abc123`)).toBe(MACHINE_FAILED)
    expect(publicReason(storage('~/a b; rm -rf /'))).toBe(MACHINE_FAILED)
    expect(publicReason('CREATION_STORAGE_FAILED: see /Users/stone/secret')).toBe(MACHINE_FAILED)
  })
})
