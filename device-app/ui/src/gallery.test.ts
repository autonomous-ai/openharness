import { describe, expect, it } from 'vitest'

import { draw, STATES } from './gallery'
import { render } from './screens'

// Every screen with every phase the contract's screen table lists.
const CONTRACT_PAIRS = [
  'install.working',
  'install.failed',
  'sign_in.offer',
  'sign_in.working',
  'sign_in.browser',
  'sign_in.failed',
  'claude.offer',
  'claude.working',
  'claude.failed',
]

describe('gallery', () => {
  it('the gallery draws every state in both themes', () => {
    expect(STATES).toHaveLength(11)
    expect(new Set(STATES.map(({ view }) => `${view.screen}.${view.phase}`))).toEqual(new Set(CONTRACT_PAIRS))

    const root = document.createElement('div')
    draw(root)

    for (const theme of ['light', 'dark']) {
      const frames = [...root.querySelectorAll<HTMLElement>(`[data-theme="${theme}"] .frame`)]
      expect(frames).toHaveLength(STATES.length)
      frames.forEach((frame, i) => {
        expect(frame.style.width).toBe('420px')
        expect(frame.style.height).toBe('320px')
        expect(frame.closest('figure')?.querySelector('figcaption')?.textContent).toBe(STATES[i].name)

        const alone = document.createElement('div')
        render(alone, STATES[i].view, () => {})
        expect(frame.querySelector('.heading')?.textContent).toBe(alone.querySelector('.heading')?.textContent)
        expect(frame.innerHTML).toBe(alone.innerHTML)
      })

      const focused = root.querySelectorAll(`[data-theme="${theme}"] .frame.focused`)
      expect(focused).toHaveLength(1)
      expect(focused[0].querySelector('.primary')?.textContent).toBe('Sign in')

      const trays = root.querySelectorAll<HTMLImageElement>(`[data-theme="${theme}"] .bar img.tray`)
      expect(trays).toHaveLength(1)
      expect(trays[0].getAttribute('src')).toBe('../src-tauri/icons/tray.png')
    }
    expect(root.querySelectorAll('img.tray')).toHaveLength(2)
  })
})
