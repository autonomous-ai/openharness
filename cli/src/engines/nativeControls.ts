/** Explicit inline composition; supervised core does not import the native control client. */
import { nativeControl as codex } from './codex/nativeControl.js'
export const nativeControlFor = (engine: string) => engine === 'codex' ? codex : undefined
