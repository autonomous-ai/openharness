import { expect, it } from 'vitest'
import { hooks } from './hookContract.js'

// The one way a Claude Code session outside a pane says it waits for the person (hook/notify.mjs).
it('claude hook contract includes Notification', () => {
  expect(hooks.settings.events).toContainEqual({ event: 'Notification' })
})
