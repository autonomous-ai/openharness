// The engine side of a typing measurement: every key redraws the input line, as Claude Code's composer
// does, so an echo is a real redraw and not the kernel's line discipline. Ctrl+C ends it.
process.stdin.setRawMode(true)
let line = ''
process.stdout.write('\x1b[?2004h> ready\r\n')
process.stdin.on('data', (data) => {
  for (const c of data.toString()) {
    if (c === '\x03') process.exit(0)
    line = c === '\x7f' ? line.slice(0, -1) : line + c
  }
  process.stdout.write(`\r\x1b[0J\x1b[39m❯ ${line}\x1b[0m`)
})
