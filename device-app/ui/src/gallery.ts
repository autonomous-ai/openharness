// Every screen in every state, light and dark, at the window's size: what the design doc's Harness Device section
// points to. The lines are made up, but Orca's, which are Orca 1.4.262's own; the words around them are render's own.
import type { View } from './api'
import { render } from './screens'

const RUNS =
  'Runs its own code in a separate Node.js process on the Orca host, with your user account’s access to that machine.'
const WORKSPACE_READ =
  'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change'

// focused draws the primary button's focus ring, which a page shows on one element at a time (gallery.html).
export const STATES: { name: string; view: View; focused?: true }[] = [
  { name: 'Install · working', view: { screen: 'install', phase: 'working', lines: ['Installing tmux…'] } },
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
  { name: 'Sign in · offer, focused', view: { screen: 'sign_in', phase: 'offer', lines: [] }, focused: true },
  { name: 'Sign in · working', view: { screen: 'sign_in', phase: 'working', lines: [] } },
  { name: 'Sign in · browser', view: { screen: 'sign_in', phase: 'browser', lines: [] } },
  {
    name: 'Sign in · browser, waiting',
    view: { screen: 'sign_in', phase: 'browser', lines: ['Harness is finishing an update'] },
  },
  { name: 'Sign in · failed', view: { screen: 'sign_in', phase: 'failed', lines: ['Sign-in did not finish.'] } },
  { name: 'Orca · asking', view: { screen: 'orca', phase: 'asking', lines: ['Asking Orca…'] } },
  // The two lines Orca 1.4.262 lists for the plugin.
  { name: 'Orca · connect', view: { screen: 'orca', phase: 'approve', lines: [RUNS, WORKSPACE_READ] } },
  {
    name: 'Orca · update, long',
    view: {
      screen: 'orca',
      phase: 'approve',
      // Ten lines, the most Rust sends, in Orca 1.4.262's words: the list scrolls.
      lines: [
        RUNS,
        WORKSPACE_READ,
        'Open and rename your workspaces, hide projects from the sidebar or show them again, focus their terminals, open their files in Orca, and run its built-in commands',
        "Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say",
        'Start and resume agents in your workspaces, local and SSH',
        'Open terminals, close the ones it opened or that are in your focused workspace, and type and run commands in your terminals, local and SSH',
        'Read the output of your terminals, local and SSH',
        'Read your automations: their names, prompts, agents, projects, workspaces and schedules',
        'Create automations that start agents in your projects on a schedule, even when the plugin is not running, and change or delete them (Orca asks you first for ones the plugin did not create, and before it changes what one with extra agent settings runs)',
        'Show desktop notifications labeled with the plugin name',
      ],
      update: true,
    },
  },
  { name: 'Orca · done', view: { screen: 'orca', phase: 'done', lines: [] } },
  { name: 'Orca · not running', view: { screen: 'orca', phase: 'failed', lines: ["Orca isn't running."] } },
  { name: 'Orca · failed', view: { screen: 'orca', phase: 'failed', lines: ["Couldn't connect Orca."] } },
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
  tray.alt = 'Harness'
  bar.append(tray)

  const grid = document.createElement('div')
  grid.className = 'grid'
  for (const { name: caption, view, focused } of STATES) {
    const figure = document.createElement('figure')
    const frame = document.createElement('div')
    frame.className = focused ? 'frame focused' : 'frame'
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
  // Drawn apart from the page, so render's focus lands on none of the windows.
  root.replaceChildren(theme('light'), theme('dark'))
}

// gallery.html has #gallery; a test imports draw without one.
const gallery = document.getElementById('gallery')
if (gallery) draw(gallery)
