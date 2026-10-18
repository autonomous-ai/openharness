#!/usr/bin/env node
/**
 * The shape every runtime manifest shares: `{ <name>: { <platform>: { version, url, sha256, size[, archiveRoot] } } }`
 * (runtimeInstall.ts artifactFor, install.ps1 Get-HarnessManifests). The publish scripts write it through one merge,
 * so a publish replaces only the platforms it ships, and every other platform and key stays: the Windows Node
 * publish must not touch the Mac's keys.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A manifest from disk. A missing or empty one is `{}` (the first publish to a new prefix); malformed JSON throws, so a publish never overwrites a manifest it could not read. */
export function readDocument(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  if (!raw.trim()) return {}
  const value = JSON.parse(raw)
  if (!isObject(value)) throw new Error(`${path} does not hold a JSON object`)
  return value
}

/** One platform's entry, checked against what its readers trust: https only, a hex sha256, a real size. */
export function runtimeEntry({ version, url, sha256, size, archiveRoot }) {
  if (!version) throw new Error('an entry needs a version')
  if (!/^https:\/\//.test(String(url))) throw new Error(`an entry's url must be https: ${url}`)
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error(`an entry's sha256 must be 64 lowercase hex digits: ${sha256}`)
  const bytes = Number(size)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`an entry's size must be a positive number of bytes: ${size}`)
  const entry = { version: String(version), url: String(url), sha256: String(sha256), size: bytes }
  return archiveRoot ? { ...entry, archiveRoot: String(archiveRoot) } : entry
}

export function mergePlatforms(document, name, entries) {
  return { ...document, [name]: { ...(isObject(document[name]) ? document[name] : {}), ...entries } }
}

export function mergeKey(document, key, value) {
  return { ...document, [key]: value }
}

const write = (path, document) => writeFileSync(path, JSON.stringify(document, null, 2) + '\n')

function main([command, ...rest]) {
  if (command === 'entry') {
    const [file, platform, version, url, sha256, size, archiveRoot] = rest
    const document = readDocument(file)
    document[platform] = runtimeEntry({ version, url, sha256, size, archiveRoot })
    return write(file, document)
  }
  if (command === 'platforms') {
    const [src, dst, name, entriesFile] = rest
    return write(dst, mergePlatforms(readDocument(src), name, JSON.parse(readFileSync(entriesFile, 'utf8'))))
  }
  if (command === 'key') {
    const [src, dst, key, valueFile] = rest
    const value = JSON.parse(readFileSync(valueFile, 'utf8'))
    if (!isObject(value)) throw new Error(`${valueFile} does not hold an object`)
    return write(dst, mergeKey(readDocument(src), key, value))
  }
  throw new Error('usage: runtimeManifest.mjs entry <file> <platform> <version> <url> <sha256> <size> [archiveRoot] | platforms <src> <dst> <name> <entries.json> | key <src> <dst> <key> <value.json>')
}

/** Whether this file is the script node was started with: argv[1] through its links, as import.meta.url is the real path. */
function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href } catch { return false }
}

if (isMain()) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(`error: ${error.message}`); process.exit(1) }
}
