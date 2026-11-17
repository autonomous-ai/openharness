// The gate's hands inside the throwaway VS Code (../realVscode.gate.ts), run as its extension tests: it connects to the
// gate's control socket and answers one NDJSON line per asked line, `{ error }` when the ask failed. It touches nothing
// the extension under test does; the extension is the installed one. Its run ending, on `exit` or the gate gone, ends
// VS Code with code 0.
const { connect } = require('node:net')
const vscode = require('vscode')

const asks = {
  async terminals() {
    const made = [vscode.window.createTerminal({ name: 'one' }), vscode.window.createTerminal({ name: 'two' })]
    return { terminals: await Promise.all(made.map((terminal) => terminal.processId)) }
  },
  async active() {
    const terminal = vscode.window.activeTerminal
    return { active: (terminal && (await terminal.processId)) ?? null }
  },
}

/** The answer, or the failure's message: the gate is told, never left waiting. */
const answer = (ask) => Promise.resolve().then(() => asks[ask]()).catch((error) => ({ error: String(error?.message ?? error) }))

exports.run = () =>
  new Promise((done) => {
    const socket = connect(process.env.HARNESS_GATE_CONTROL)
    let held = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      held += chunk
      for (let end = held.indexOf('\n'); end !== -1; end = held.indexOf('\n')) {
        const { ask } = JSON.parse(held.slice(0, end))
        held = held.slice(end + 1)
        if (ask === 'exit') socket.end()
        else answer(ask).then((line) => socket.write(`${JSON.stringify(line)}\n`))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => done())
  })
