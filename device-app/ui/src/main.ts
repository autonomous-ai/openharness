// The window's entry: draws what Rust says the window shows, and sends back what the person presses.
import { act, onView, view, type View } from './api'
import { render } from './screens'

export async function start(root: HTMLElement): Promise<void> {
  const draw = (next: View | null) => render(root, next, (action) => void act(action))
  // Listen first, so a view Rust sends while view() is on its way is not missed.
  await onView(draw)
  draw(await view())
}

// The page always has #app; a test imports start without one.
const app = document.getElementById('app')
if (app) void start(app)
