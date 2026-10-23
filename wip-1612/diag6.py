import sys
p = sys.argv[1]
s = open(p).read()
old = "      await d.tmux.run('send-keys', '-t', pane, 'C-z')\n"
new = old + """      await new Promise((r) => setTimeout(r, 2000))
      const piped = (await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pipe}')).trim()
      console.log(`---- DIAG2 pane_pipe=${piped} exists=${existsSync(written)} output=${JSON.stringify(output())}`)
"""
assert old in s
open(p, 'w').write(s.replace(old, new))
