import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMachineNames, hostnameReader, MACHINE_NAMES_KEPT } from './machineNames.js'

/** A machine whose name is whatever the test last set. */
function machine(first: string) {
  let name = first
  const read = vi.fn(() => name)
  return { read, rename: (next: string) => { name = next } }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.HARNESSD_TEST_HOSTNAME_FILE
  vi.resetModules()
})

describe('the names a machine has gone by', () => {
  it('owns the name it has at start, in full and as its first part, in any case', () => {
    const names = createMachineNames(() => 'MacBook.lan')
    for (const title of ['macbook.lan', 'MacBook.lan', 'MACBOOK', 'macbook']) expect(names.owns(title), title).toBe(true)
    for (const title of ['Fix the login page', 'lan', 'MacBook2.lan', 'macbook pro.lan']) expect(names.owns(title), title).toBe(false)
  })

  it('owns its name under another network, which a daemon started since has never seen it on', () => {
    // Agents made on the home network keep their panes' titles across an update made on another.
    const names = createMachineNames(() => 'MacBook-Pro.local')
    for (const title of ['MacBook-Pro.lan', 'macbook-pro.example.com']) expect(names.owns(title), title).toBe(true)
    for (const title of ['MacBook-Pro-2.lan', 'MacBook-Pro is ready', 'MacBook-Pro.lan: build']) expect(names.owns(title), title).toBe(false)
  })

  it('keeps the name it had after it moves on: a pane made under it still carries it', () => {
    const laptop = machine('MacBook.lan')
    const names = createMachineNames(laptop.read)
    laptop.rename('Studio.local')
    expect(names.owns('studio.local')).toBe(false)   // read again only when asked
    names.observe()
    for (const title of ['MacBook.lan', 'MacBook', 'Studio.local', 'Studio']) expect(names.owns(title), title).toBe(true)
  })

  it('reads the name when asked and never per title', () => {
    const laptop = machine('MacBook.lan')
    const names = createMachineNames(laptop.read)
    for (let i = 0; i < 10; i++) names.owns(`title ${i}`)
    expect(laptop.read).toHaveBeenCalledTimes(1)
    names.observe()
    expect(laptop.read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last names it saw, a name seen again counting as just seen', () => {
    const laptop = machine('home.lan')
    const names = createMachineNames(laptop.read, 2)
    laptop.rename('cafe.lan')
    names.observe()
    laptop.rename('home.lan')
    names.observe()                     // seen again: now the most recent
    laptop.rename('office.local')
    names.observe()                     // a third name: the least recently seen, cafe.lan, goes
    for (const title of ['home.lan', 'home', 'office.local', 'office']) expect(names.owns(title), title).toBe(true)
    for (const title of ['cafe.lan', 'cafe']) expect(names.owns(title), title).toBe(false)
  })

  it('holds no more than its limit, however many networks the machine roams', () => {
    const laptop = machine('network-0.lan')
    const names = createMachineNames(laptop.read)
    for (let i = 1; i <= 100; i++) {
      laptop.rename(`network-${i}.lan`)
      names.observe()
    }
    expect(names.owns('network-100.lan')).toBe(true)
    expect(names.owns(`network-${101 - MACHINE_NAMES_KEPT}.lan`)).toBe(true)
    expect(names.owns(`network-${100 - MACHINE_NAMES_KEPT}.lan`)).toBe(false)
  })

  it('forgets nothing when the name cannot be read, or reads as nothing', () => {
    const laptop = machine('MacBook.lan')
    const names = createMachineNames(laptop.read)
    laptop.read.mockImplementationOnce(() => { throw new Error('EPERM') })
    names.observe()
    laptop.rename('  ')
    names.observe()
    expect(names.owns('MacBook.lan')).toBe(true)
    expect(names.owns('')).toBe(false)
  })

  it('owns nothing when no name was ever read', () => {
    const names = createMachineNames(() => { throw new Error('EPERM') })
    expect(names.owns('localhost')).toBe(false)
  })
})

describe('where the machine\'s name is read', () => {
  it('asks the operating system', () => {
    expect(hostnameReader(undefined)).toBe(hostname)
  })

  it('end to end, reads a file that stands in for it, and the system\'s own until the file holds a name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'machine-names-'))
    dirs.push(dir)
    const file = join(dir, 'hostname')
    const read = hostnameReader(file)
    expect(read()).toBe(hostname())
    writeFileSync(file, '')
    expect(read()).toBe(hostname())
    writeFileSync(file, 'laptop-one.lan\n')
    expect(read()).toBe('laptop-one.lan')
  })

  it('the daemon\'s own reads the file HARNESSD_TEST_HOSTNAME_FILE names, from its first read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'machine-names-'))
    dirs.push(dir)
    process.env.HARNESSD_TEST_HOSTNAME_FILE = join(dir, 'hostname')
    writeFileSync(process.env.HARNESSD_TEST_HOSTNAME_FILE, 'laptop-one.lan')
    vi.resetModules()
    const { machineNames } = await import('./machineNames.js')
    expect(machineNames.owns('laptop-one.lan')).toBe(true)
    writeFileSync(process.env.HARNESSD_TEST_HOSTNAME_FILE, 'laptop-two.local')
    machineNames.observe()
    expect(machineNames.owns('laptop-one.lan')).toBe(true)
    expect(machineNames.owns('laptop-two')).toBe(true)
  })
})
