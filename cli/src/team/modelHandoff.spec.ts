import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyTeamModel, receiveTeamModel, takeModelHandoff, writeModelHandoff } from "./modelHandoff.js"

const handoff = { connections: JSON.stringify({ version: 1, connections: [{ id: "openrouter", apiKey: "sk-x" }] }),
  payload: JSON.stringify({ clear: false, model: "m1", env: { ANTHROPIC_BASE_URL: "https://b", ANTHROPIC_AUTH_TOKEN: "sk-x", ANTHROPIC_API_KEY: "" } }) }

describe("the Team model handover on Windows", () => {
  let root: string, folder: string, file: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "team-model-")); folder = join(root, "handoff"); mkdirSync(folder); file = join(folder, "team-model") })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("hands over once: what the owner wrote is read, and gone", () => {
    writeModelHandoff(handoff, file)
    expect(takeModelHandoff(file)).toEqual(handoff)
    expect(existsSync(file)).toBe(false)
    expect(takeModelHandoff(file)).toBeNull()
  })

  it("refuses a folder or a file that is a link, and never reads one", () => {
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere)
    const linked = join(root, "linked"); symlinkSync(elsewhere, linked)
    expect(() => writeModelHandoff(handoff, join(linked, "team-model"))).toThrow(/not a plain folder/)
    writeFileSync(join(root, "secret"), JSON.stringify(handoff))
    symlinkSync(join(root, "secret"), file)
    expect(() => takeModelHandoff(file)).toThrow(/not a plain file/)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(root, "secret"))).toBe(true)
  })

  it("deletes what is not a handover, and says so", () => {
    writeFileSync(file, "not json")
    expect(() => takeModelHandoff(file)).toThrow(/not a model handover/)
    expect(existsSync(file)).toBe(false)
  })

  it("writes the saved API and the engine settings, keeping the settings it does not own", () => {
    const home = join(root, "home"), dataDir = join(root, "data")
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1", ANTHROPIC_API_KEY: "old" } }))
    applyTeamModel(handoff, { home, dataDir })
    expect(readFileSync(join(dataDir, "api-connections", "connections.json"), "utf8")).toBe(handoff.connections)
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
    expect(settings).toMatchObject({ theme: "dark", model: "m1", env: { KEEP: "1", ANTHROPIC_BASE_URL: "https://b", ANTHROPIC_AUTH_TOKEN: "sk-x", ANTHROPIC_API_KEY: "" } })
  })

  it("clears it again, leaving what is not its own", () => {
    const home = join(root, "home"), dataDir = join(root, "data")
    applyTeamModel(handoff, { home, dataDir })
    applyTeamModel({ connections: JSON.stringify({ version: 1, connections: [], recognizedBases: [] }), payload: JSON.stringify({ clear: true }) }, { home, dataDir })
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
    expect(settings.model).toBeUndefined()
    expect(settings.env).toBeUndefined()
    expect(existsSync(join(dataDir, "api-connections", "connections.json"))).toBe(false)
  })

  it("reports what it did to the owner, never the key", () => {
    const home = join(root, "home"), dataDir = join(root, "data"), report = vi.fn()
    writeModelHandoff(handoff, file)
    receiveTeamModel({ file, home, dataDir, now: () => 42, report })
    expect(report).toHaveBeenCalledWith({ model: { state: "applied", at: 42 } })
    expect(JSON.stringify(report.mock.calls)).not.toContain("sk-x")
    report.mockClear()
    receiveTeamModel({ file, home, dataDir, now: () => 43, report })
    expect(report).not.toHaveBeenCalled()
    writeFileSync(file, "not json")
    receiveTeamModel({ file, home, dataDir, now: () => 44, report })
    expect(report).toHaveBeenCalledWith({ model: { state: "failed", at: 44, detail: expect.stringContaining("not a model handover") } })
  })
})
