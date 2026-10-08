import type { ScreenReading } from '../engines/facets/screen.js'
import type { RegisteredSession } from './registry.js'

/** Null means unavailable, not an empty screen or a closed question. */
export type ScreenReader = (session: RegisteredSession, capture: string | null) => Promise<ScreenReading | null>
