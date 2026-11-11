/** A Swarm message typed into a Codex that does not shade its composer (CLI end to end, 2026-11-11): who it is from, the text,
 *  and the line to answer with, in paragraphs, the footer under them. Its Enter was held back: the read ended the draft at its
 *  first blank row and took the rest for a screen under it. */
export const CODEX_SWARM_MESSAGE = ['', '', '\u001b[1m›\u001b[0m In conversation offline-editing.', '  ', '  @a7d124ef722bfe7db4f54ae0, to you:',
  '  Verify offline editing on the member machine', '  ',
  "  Answer: '/usr/local/bin/node' '--max-semi-space-size=4' '--max-old-space-size=4096' '/tmp/harness-e2e-bundl",
  "  e-gJxO0l/cli.js' super-tab --port 51584 --machine 'b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6' --tab 'shared-work",
  "  ' --agent '37af1f9dbca265339ee1831a' post 'offline-editing' 'your message' UNIQUE_OPERATION_ID --answers",
  "   'message-1'", '', '  \u001b[2mgpt-6 high · /tmp/htmux-e2e/projects/project\u001b[0m'].join('\n')
