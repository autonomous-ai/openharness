import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The script caches its own downloads (esptool, firmware) under `~/.harness/flasher` via
 * `HARNESS_FLASHER_CACHE`. Keeping our copy of the script in the same directory is deliberate: one
 * place holds everything the flasher owns, so "delete this folder" is a complete reset. Its own module, so that
 * `harness start --if-down` reads the flash's markers here without loading the flasher (lib/startIfDown.ts).
 */
export const FLASHER_DIR = process.env.HARNESS_FLASHER_CACHE || join(homedir(), '.harness', 'flasher')
