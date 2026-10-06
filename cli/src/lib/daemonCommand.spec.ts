import { describe, expect, it } from 'vitest'
import { daemonCommand } from './daemonCommand.js'

describe('the command an agent\'s shell runs this harness\'s CLI with', () => {
  it('is this process\'s Node, its flags and its script, each quoted for a shell', () => {
    expect(daemonCommand('/usr/local/bin/node', ['--import', 'tsx'], "/Users/o'neil/cli.js"))
      .toBe(`'/usr/local/bin/node' '--import' 'tsx' '/Users/o'"'"'neil/cli.js'`)
    expect(daemonCommand()).toContain(`'${process.argv[1]}'`)
  })
})
