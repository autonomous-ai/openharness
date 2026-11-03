import type { SuperTabState } from './model.js'
import { usernameOf } from './usernames.js'

export const MAX_NAME_LENGTH = 40

export const shownNameOf = (state: SuperTabState, id: string): string | undefined => usernameOf(state, id)
