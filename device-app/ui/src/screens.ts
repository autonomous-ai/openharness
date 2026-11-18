// The three screens, Install, Sign in and Orca, drawn from one View. Every word is the plan's approved copy. Lines come
// from outside (a script's output, an error, Orca's grants), so they reach the page through textContent only.
import type { Action, Phase, Screen, View } from './api'

type Body =
  | { kind: 'sentences'; text: string[] }
  | { kind: 'spinner' }
  // The spinner, and under it lines[0] when there is one: the install's step.
  | { kind: 'step' }
  // The install script's last lines, monospace.
  | { kind: 'output' }
  // lines[0] when there is one.
  | { kind: 'note' }
  | { kind: 'error' }
  // What Orca will let the plugin do, one list item per line, in Orca's words.
  | { kind: 'grants' }

interface Button {
  label: string
  action: Action
  primary?: boolean
}

interface Face {
  heading: string
  body: Body
  buttons: Button[]
}

const SPINNER: Body = { kind: 'spinner' }
const RETRY: Button = { label: 'Retry', action: 'retry', primary: true }
const CANCEL: Button = { label: 'Cancel', action: 'cancel' }
const ORCA = 'Connect Orca'

// Rust never sends a pair missing here; one would draw nothing. Buttons are in the order drawn: secondary first,
// primary last, as the desktop's dialogs (swarm_dialogs.dart).
const FACES: Partial<Record<`${Screen}.${Phase}`, Face>> = {
  'install.working': { heading: 'Setting up Harness', body: { kind: 'step' }, buttons: [] },
  'install.failed': {
    heading: 'Setting up Harness',
    body: { kind: 'output' },
    buttons: [{ label: 'Retry', action: 'retry' }],
  },
  'sign_in.offer': {
    heading: 'Sign in',
    body: { kind: 'sentences', text: ['Add your other computers to your device.'] },
    buttons: [{ label: 'Later', action: 'later' }, { label: 'Sign in', action: 'sign_in', primary: true }],
  },
  'sign_in.working': { heading: 'Sign in', body: SPINNER, buttons: [CANCEL] },
  'sign_in.browser': { heading: 'Finish in your browser', body: { kind: 'note' }, buttons: [CANCEL] },
  'sign_in.failed': { heading: 'Sign in', body: { kind: 'error' }, buttons: [RETRY] },
  'orca.asking': { heading: ORCA, body: { kind: 'step' }, buttons: [] },
  'orca.approve': {
    heading: ORCA,
    body: { kind: 'grants' },
    buttons: [CANCEL, { label: 'Connect', action: 'connect_orca', primary: true }],
  },
  'orca.done': {
    heading: ORCA,
    body: { kind: 'sentences', text: ['Orca connected.'] },
    buttons: [{ label: 'Done', action: 'cancel', primary: true }],
  },
  'orca.failed': { heading: ORCA, body: { kind: 'error' }, buttons: [{ label: 'Close', action: 'cancel' }] },
}

// An update is Connect in every phase but its heading and the button that approves.
function updated(face: Face): Face {
  return {
    ...face,
    heading: 'Update Orca connection',
    buttons: face.buttons.map((button) => (button.action === 'connect_orca' ? { ...button, label: 'Update' } : button)),
  }
}

// The contract's "at most 4": the script's last lines say why it failed.
const OUTPUT_LINES = 4

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// Named by the screen's heading, and by the step under it when there is one: render gives the step id body-0, the
// first of the body's nodes with text.
function spinner(withStep = false): HTMLElement {
  const spinner = element('div', 'spinner')
  spinner.setAttribute('role', 'status')
  spinner.setAttribute('aria-labelledby', withStep ? 'heading body-0' : 'heading')
  return spinner
}

function body(kind: Body, lines: string[]): HTMLElement[] {
  switch (kind.kind) {
    case 'sentences':
      return kind.text.map((sentence) => element('p', 'body', sentence))
    case 'spinner':
      return [spinner()]
    case 'step':
      return lines.length > 0 ? [spinner(true), element('p', 'body muted', lines[0])] : [spinner()]
    case 'output': {
      const output = element('div', 'output')
      output.setAttribute('role', 'alert')
      output.append(...lines.slice(-OUTPUT_LINES).map((line) => element('p', 'line', line)))
      return [output]
    }
    case 'note':
      return lines.length > 0 ? [element('p', 'body muted', lines[0])] : []
    case 'error': {
      if (lines.length === 0) return []
      const error = element('p', 'body error', lines[0])
      error.setAttribute('role', 'alert')
      return [error]
    }
    case 'grants': {
      const list = element('ul', 'grants')
      list.append(...lines.map((line) => element('li', 'grant', line)))
      return [element('p', 'body', 'Orca will let Harness Device:'), list]
    }
  }
}

/** Draws one screen into root; null draws nothing. */
export function render(root: HTMLElement, view: View | null, act: (action: Action) => void): void {
  root.replaceChildren()
  const found = view && FACES[`${view.screen}.${view.phase}`]
  if (!view || !found) return
  const face = view.update ? updated(found) : found

  const screen = element('main', 'screen')
  const content = element('div', 'content')
  const under = body(face.body, view.lines)
  const heading = element('h1', 'heading', face.heading)
  heading.id = 'heading'
  content.append(heading, ...under)
  // The text a screen reader reads after the focused button's label. The window shows one screen at a time, so the ids
  // are unique in it.
  const text = under.filter((node) => node.textContent)
  text.forEach((node, i) => (node.id = `body-${i}`))
  screen.append(content)

  if (face.buttons.length > 0) {
    const row = element('div', 'buttons')
    for (const { label, action, primary } of face.buttons) {
      const button = element('button', primary ? 'button primary' : 'button', label) as HTMLButtonElement
      button.type = 'button'
      if (primary && text.length > 0) button.setAttribute('aria-describedby', text.map((node) => node.id).join(' '))
      button.addEventListener('click', () => act(action))
      row.append(button)
    }
    screen.append(row)
  }

  root.append(screen)
  // Return takes the primary answer, as a dialog's default button does. A screen without one focuses nothing: the
  // window can come up while the person types elsewhere, and Return must not press Cancel. Nor on the Orca screen:
  // a Return typed in another app's habit must approve nothing, so the person clicks or tabs to Connect.
  if (view.screen !== 'orca') root.querySelector<HTMLElement>('.primary')?.focus()
}
