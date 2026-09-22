// HTTP persistence for native bond scans. Computation and exports always come from RDKit.
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'

function shelf(workspace, create = false) {
  let folder = realpathSync(workspace)
  for (const name of ['out', 'torsions']) {
    folder = join(folder, name)
    if (!existsSync(folder) && create) mkdirSync(folder)
    if (!existsSync(folder)) return null
    const stat = lstatSync(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('out/torsions must be a real workspace directory')
  }
  return folder
}

export function createTorsionService({ workspace, ask }) {
  let running = false
  const list = () => {
    let root
    try {
      root = shelf(workspace)
    } catch {
      return []
    }
    if (!root) return []
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)
      )
      .flatMap((entry) => {
        try {
          const path = join(root, entry.name, 'study.json'),
            stat = lstatSync(path)
          if (stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return []
          const study = JSON.parse(readFileSync(path, 'utf8'))
          if (
            study.spec !== 'rdkit-torsion/1' ||
            typeof study.title !== 'string' ||
            !Array.isArray(study.frames)
          )
            return []
          return [
            {
              id: entry.name,
              title: study.title,
              molecule: study.record?.name,
              angle: study.frames[study.selectedIndex]?.angle,
              mtime: stat.mtimeMs
            }
          ]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100)
  }
  async function calculate(action, body) {
    if (running)
      throw Object.assign(
        new Error('A bond scan is already running. Try again in a moment.'),
        { code: 409 }
      )
    if (
      !body ||
      typeof body.molblock !== 'string' ||
      Buffer.byteLength(body.molblock) > 128 * 1024 ||
      typeof body.name !== 'string' ||
      body.name.length > 100
    )
      throw Object.assign(
        new Error('Provide the current 3D MOL block and molecule name'),
        { code: 400 }
      )
    if (!['options', 'scan', 'keep'].includes(action))
      throw Object.assign(new Error('Unknown bond scan action'), { code: 404 })
    if (
      action !== 'options' &&
      (!Array.isArray(body.atoms) ||
        body.atoms.length !== 4 ||
        !body.atoms.every(Number.isInteger))
    )
      throw Object.assign(new Error('Choose four atom indices'), { code: 400 })
    if (
      action === 'keep' &&
      (typeof body.title !== 'string' ||
        body.title.length > 100 ||
        typeof body.note !== 'string' ||
        body.note.length > 1000 ||
        !Number.isInteger(body.selected))
    )
      throw Object.assign(
        new Error('Provide a study name, selected angle and note'),
        { code: 400 }
      )
    const input = {
      molblock: body.molblock,
      name: body.name,
      atoms: body.atoms,
      step: body.step
    }
    running = true
    let scratch
    try {
      if (action !== 'keep') return await ask('torsion_' + action, input)
      const root = shelf(workspace, true),
        id = randomUUID()
      scratch = join(root, '.saving-' + id)
      mkdirSync(scratch)
      await ask('torsion_keep', {
        ...input,
        destination: scratch,
        title: body.title,
        selected: body.selected,
        note: body.note,
        fingerprint: body.fingerprint
      })
      if (
        !existsSync(join(scratch, 'study.zip')) ||
        !existsSync(join(scratch, 'study.json'))
      )
        throw new Error('RDKit did not produce the study archive')
      renameSync(scratch, join(root, id))
      scratch = null
      return { id, path: `out/torsions/${id}` }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
      running = false
    }
  }
  return { list, calculate }
}
