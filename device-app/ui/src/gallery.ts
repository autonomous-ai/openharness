// Every screen in every state, light and dark, at the window's size: what the design doc's Harness Device section
// points to. The lines are made up; the words around them are render's own.
import type { View } from './api'
import { render } from './screens'

export const STATES: { name: string; view: View }[] = [
  { name: 'Install · working', view: { screen: 'install', phase: 'working', lines: [] } },
  {
    name: 'Install · failed',
    view: {
      screen: 'install',
      phase: 'failed',
      lines: [
        '==> Installing Harness',
        '==> Downloading the CLI',
        // 120 characters, the longest line Rust sends.
        'curl: (6) Could not resolve host: cdn.autonomous.ai while fetching https://cdn.autonomous.ai/harness/cli/macos-arm64.tgz',
        'exit 6',
      ],
    },
  },
  { name: 'Sign in · offer', view: { screen: 'sign_in', phase: 'offer', lines: [] } },
  { name: 'Sign in · working', view: { screen: 'sign_in', phase: 'working', lines: [] } },
  { name: 'Sign in · browser', view: { screen: 'sign_in', phase: 'browser', lines: [] } },
  {
    name: 'Sign in · browser, waiting',
    view: { screen: 'sign_in', phase: 'browser', lines: ['Harness is finishing an update'] },
  },
  { name: 'Sign in · failed', view: { screen: 'sign_in', phase: 'failed', lines: ['Sign-in did not finish.'] } },
  { name: 'Claude Code · offer', view: { screen: 'claude', phase: 'offer', lines: [] } },
  { name: 'Claude Code · working', view: { screen: 'claude', phase: 'working', lines: [] } },
  {
    name: 'Claude Code · failed',
    view: { screen: 'claude', phase: 'failed', lines: ['Could not change Claude Code.'] },
  },
]

// The window's size in tauri.conf.json.
const WIDTH = 420
const HEIGHT = 320

function theme(name: 'light' | 'dark'): HTMLElement {
  const section = document.createElement('section')
  section.className = 'theme'
  section.dataset.theme = name

  // The menu bar draws the tray icon as a template: black on a light bar, white on a dark one (gallery.html).
  const bar = document.createElement('div')
  bar.className = 'bar'
  const tray = document.createElement('img')
  tray.className = 'tray'
  tray.src = '../src-tauri/icons/tray.png'
  tray.alt = 'Harness Device'
  bar.append(tray)

  const grid = document.createElement('div')
  grid.className = 'grid'
  for (const { name: caption, view } of STATES) {
    const figure = document.createElement('figure')
    const frame = document.createElement('div')
    frame.className = 'frame'
    frame.style.width = `${WIDTH}px`
    frame.style.height = `${HEIGHT}px`
    // The gallery's buttons do nothing.
    render(frame, view, () => {})
    const label = document.createElement('figcaption')
    label.textContent = caption
    figure.append(frame, label)
    grid.append(figure)
  }

  section.append(bar, grid)
  return section
}

/** Draws every state, once light and once dark. */
export function draw(root: HTMLElement): void {
  // Drawn apart from the page, so render's focus lands on none of the twenty windows.
  root.replaceChildren(theme('light'), theme('dark'))
}

// gallery.html has #gallery; a test imports draw without one.
const gallery = document.getElementById('gallery')
if (gallery) draw(gallery)
