import sys
p = sys.argv[1]
s = open(p).read()
L = lambda m: f"    appendFileSync('/tmp/fake-stdin.log', `${{Date.now()}} {m}\\n`)\n"
old = """    process.stdout.write('\\x1b[?2004l')
    if (engine === 'claude') process.stdout.write('\\r\\nClaude Code has been suspended. Run `fg` to bring Claude Code back.\\r\\n')
    process.stdin.setRawMode?.(false)
    process.once('SIGCONT', () => {
      process.stdin.setRawMode?.(true)
      process.stdout.write('\\x1b[?2004h')
    })
    process.kill(0, 'SIGTSTP')
"""
assert old in s, 'suspend body'
new = (L("suspend start pid=${process.pid}") + "    process.stdout.write('\\x1b[?2004l')\n" + L("wrote 2004l")
  + "    if (engine === 'claude') process.stdout.write('\\r\\nClaude Code has been suspended. Run `fg` to bring Claude Code back.\\r\\n')\n"
  + "    process.stdin.setRawMode?.(false)\n" + L("raw off isRaw=${process.stdin.isRaw}")
  + "    process.once('SIGCONT', () => {\n" + L("SIGCONT once") + "      process.stdin.setRawMode?.(true)\n      process.stdout.write('\\x1b[?2004h')\n    })\n"
  + "    try { process.kill(0, 'SIGTSTP'); appendFileSync('/tmp/fake-stdin.log', `${Date.now()} kill(0) returned\\n`) } catch (e) { appendFileSync('/tmp/fake-stdin.log', `${Date.now()} kill threw ${e}\\n`); throw e }\n")
s = s.replace(old, new)
open(p, 'w').write(s)
