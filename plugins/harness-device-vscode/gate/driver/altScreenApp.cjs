// The gate's stand-in for Claude Code's fullscreen view (../realVscode.gate.ts), never Claude Code itself: run by the
// gate's own Node in a gate terminal. It turns on what that view turns on, the alternate screen, SGR mouse tracking
// and bracketed paste, so VS Code treats the terminal as it would treat Claude Code's, and appends every byte the
// terminal sends it to the file its first argument names. It runs until killed.
const { appendFileSync } = require('node:fs')

const record = process.argv[2]
// Raw before the modes are on: the pseudo-terminal passes each key as its bytes, with no line editing or echo, from the
// first key a terminal that sees those modes may send.
process.stdin.setRawMode(true)
process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h')
process.stdin.on('data', (chunk) => appendFileSync(record, chunk))
