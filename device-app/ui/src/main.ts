// The window's entry: draws what Rust says the window shows, and sends back what the person presses.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { act, onView, view, type View } from './api'
import { render } from './screens'

export async function start(root: HTMLElement): Promise<void> {
  const draw = (next: View | null) => render(root, next, (action) => void act(action))
  // A close is a close request, which Rust answers as the screen's Later or Not now.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void getCurrentWindow().close()
  })
  // Listen first, so a view Rust sends while view() is on its way is not missed. Events and view()'s answer are not
  // ordered: once an event has come, the answer may be older, and drawing it would leave buttons acting on a screen
  // the window no longer shows.
  let heard = false
  await onView((next) => {
    heard = true
    draw(next)
  })
  const first = await view()
  if (!heard) draw(first)
}

// The page always has #app; a test imports start without one.
const app = document.getElementById('app')
if (app) void start(app)
