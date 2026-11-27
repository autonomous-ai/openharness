/** A message in paragraphs typed into a Codex that does not shade its composer (CLI end to end, 2026-11-11), its footer under
 *  them. Its Enter was held back: the read ended the draft at its first blank row and took the rest for a screen under it. */
export const CODEX_PARAGRAPH_DRAFT = ['', '', '\u001b[1m›\u001b[0m About offline editing.', '  ', '  On the second machine:',
  '  Verify offline editing there', '  ',
  "  Then run '/usr/local/bin/node' '--max-old-space-size=4096' '/tmp/harness-e2e-bundle-gJxO0l/cli.js' new --port 51584",
  "  --machine 'b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6' 'offline-editing' and say what it printed, with the first line of each",
  "  error and the file it came from, in one message to the agent that asked",
  "   'message-1'", '', '  \u001b[2mgpt-6 high · /tmp/htmux-e2e/projects/project\u001b[0m'].join('\n')
