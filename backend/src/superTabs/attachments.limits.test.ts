import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES, MAX_FORM_ATTACHMENT_BYTES } from './attachments.js'

// The clients are other packages and languages, so they cannot import the server's number: each keeps its own copy, and
// this holds every copy to the server's, so a client never refuses a file the server takes or offers one it refuses.
const repo = join(import.meta.dirname, '../../..')
const value = (file: string, name: string) => {
  const line = new RegExp(`${name}\\s*=\\s*([0-9 *]+);?\\s*$`, 'm').exec(readFileSync(join(repo, file), 'utf8'))
  if (!line) throw new Error(`${name} not found in ${file}`)
  return line[1]!.split('*').map(n => Number(n.trim())).reduce((a, b) => a * b, 1)
}

describe('every client\'s attachment limit', () => {
  it.each([
    ['cli/src/superTabs/attachments.ts', 'MAX_ATTACHMENT_BYTES', MAX_ATTACHMENT_BYTES],
    ['cli/src/lib/superTabAttachmentProxy.ts', 'MAX_FORM_ATTACHMENT_BYTES', MAX_FORM_ATTACHMENT_BYTES],
    ['desktop/lib/super_tabs/attachment_upload.dart', 'kSuperTabAttachmentMaxBytes', MAX_ATTACHMENT_BYTES],
    ['desktop/lib/super_tabs/attachment_upload.dart', 'kSuperTabFormAttachmentMaxBytes', MAX_FORM_ATTACHMENT_BYTES],
    ['mobile/lib/swarm/swarm_outgoing_files.dart', 'swarmAttachmentMaxBytes', MAX_ATTACHMENT_BYTES],
    ['mobile/lib/swarm/swarm_outgoing_files.dart', 'swarmFormAttachmentMaxBytes', MAX_FORM_ATTACHMENT_BYTES],
  ])('%s %s is the server\'s', (file, name, want) => {
    expect(value(file, name)).toBe(want)
  })
})
