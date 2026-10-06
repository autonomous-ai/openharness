/**
 * What a bracketed paste may carry into a pane: the text as written, with every control character but
 * tab and newline made visible, so that nothing in it acts as a keystroke.
 *
 * A message is pasted into the engine's pane between ESC [200~ and ESC [201~ (`paste-buffer -p`), and
 * the engine takes what is between them as text. A message carrying ESC [201~ itself ends the paste
 * there, and everything after it is typed. Measured on tmux 3.2a and 3.3a, what Ubuntu 22.04 and
 * Debian 12 ship: `hello ESC[201~ CR !exit CR` ended the paste after `hello`, and the engine ran
 * `!exit` as typed input (e2e/content.e2e.ts). In Claude Code a typed `!` line is a shell command, and
 * anything that can send an agent a message can send that, other agents included. tmux 3.7c defangs
 * controls inside a bracketed paste itself (ESC reaches the engine as `^[`), which is why the same
 * message was one prompt there. The daemon now does the same, whatever tmux does.
 *
 * In tmux 3.7c's form: caret notation, `^[` for ESC, `^?` for DEL, so a message reads the same on every
 * tmux. A carriage return, alone or before a newline, is a line break: one newline each, which tmux
 * pastes as the carriage return a pasted line ends with. The 8-bit C1 controls, which a terminal may
 * read as ESC and a letter (U+009B is ESC [), are shown as that pair.
 */
export function neutralizePasteControls(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, (control) => {
      const code = control.charCodeAt(0)
      if (code === 0x7f) return '^?'
      if (code >= 0x80) return `^[${String.fromCharCode(code - 0x40)}`
      return `^${String.fromCharCode(code + 0x40)}`
    })
}
