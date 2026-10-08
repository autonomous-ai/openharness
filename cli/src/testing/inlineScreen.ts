/** Real native readers injected into unit hosts; production supervision never imports this. */
import { readerEngine } from '../engines/worker/protocol.js'
import { screenFor } from '../engines/screens.js'
import { legacyScreen } from '../lib/legacyScreen.js'
import type { ScreenReader } from '../lib/screenReader.js'
export const readInlineScreen: ScreenReader = async (session, capture) => readerEngine(session.engine)
  ? capture === null ? null : screenFor(session.engine).inspect(capture)
  : legacyScreen(session.engine, capture)
