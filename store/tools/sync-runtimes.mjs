#!/usr/bin/env node
// Keep every package's copy of runtimes.sh identical to store/tools/runtimes.sh.
//
// A package installs alone (a sparse checkout of its own folder), so it cannot source a file outside
// itself: each one that needs Python, uv or Harness's Node carries a copy — `toolchain/runtimes.sh`
// in an agent, `runtimes.sh` beside setup.sh in a viewer.
//
//   node store/tools/sync-runtimes.mjs            rewrite every copy from the canonical file
//   node store/tools/sync-runtimes.mjs --check    exit 1, naming each copy that differs or is missing
//
// "Missing" means a script in the package sources runtimes.sh and the package has no copy of it.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const store = dirname(dirname(fileURLToPath(import.meta.url)))

/** Every package folder, with where its copy lives. */
export function packages(root = store) {
  const out = []
  for (const kind of ['agents', 'viewers']) {
    const base = join(root, kind)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dir = join(base, name.name)
      out.push({ dir, copy: join(dir, kind === 'agents' ? 'toolchain' : '', 'runtimes.sh') })
    }
  }
  return out
}

/** True when a shell script in the package (not its node_modules or venv) sources runtimes.sh. */
export function sourcesRuntimes(dir) {
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.venv', 'upstream', '.git'].includes(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { if (depth < 2 && walk(p, depth + 1)) return true; continue }
      if (!e.name.endsWith('.sh') || e.name === 'runtimes.sh') continue
      if (/^\s*(\.|source)\s+.*runtimes\.sh/m.test(readFileSync(p, 'utf8'))) return true
    }
    return false
  }
  return walk(dir, 0)
}

export function check(root = store) {
  const canonical = readFileSync(join(root, 'tools', 'runtimes.sh'), 'utf8')
  const problems = []
  for (const { dir, copy } of packages(root)) {
    if (existsSync(copy)) {
      if (readFileSync(copy, 'utf8') !== canonical) problems.push(`${relative(root, copy)} differs from tools/runtimes.sh`)
    } else if (sourcesRuntimes(dir)) {
      problems.push(`${relative(root, dir)} sources runtimes.sh but has no ${relative(dir, copy)}`)
    }
  }
  return problems
}

export function sync(root = store) {
  const canonical = readFileSync(join(root, 'tools', 'runtimes.sh'), 'utf8')
  const written = []
  for (const { dir, copy } of packages(root)) {
    if (!existsSync(copy) && !sourcesRuntimes(dir)) continue
    if (existsSync(copy) && readFileSync(copy, 'utf8') === canonical) continue
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, canonical)
    written.push(relative(root, copy))
  }
  return written
}

// Run as a command (not imported): argv[1] may reach this file through a symlink, /var → /private/var.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.includes('--check')) {
    const problems = check()
    for (const p of problems) console.error(p)
    process.exit(problems.length ? 1 : 0)
  }
  for (const p of sync()) console.log(`wrote ${p}`)
}
