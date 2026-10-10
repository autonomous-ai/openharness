import { realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** Reset only a caller-owned temporary catalog, including its immutable adoption records. */
export function clearEngineHomeFixture(dataDirectory: string): void {
  const root = realpathSync(tmpdir()), directory = realpathSync(dataDirectory)
  const below = relative(root, directory)
  if (!below || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) throw new Error('A home-catalog fixture must be in a private temporary directory')
  for (const suffix of ['', '.adoptions', '.confirmations', '.adopted']) {
    rmSync(join(directory, 'engine-homes.json' + suffix), { recursive: true, force: true })
  }
}
