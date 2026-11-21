import { afterEach, expect, it, vi } from 'vitest'
import { processRows, readProcessRows, setProcessTableSource, type ProcessRow } from './processTable.js'

const native = vi.hoisted(() => vi.fn<() => Promise<ProcessRow[] | null>>())
vi.mock('./windows/processTable.js', () => ({ windowsProcessRows: native }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const rows: ProcessRow[] = [4120, 4121].map(pid => ({
  pid, parentPid: 1, executable: 'engine.exe', startMarker: `w:${pid}`, args: 'engine.exe',
}))
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  setProcessTableSource(null)
  native.mockReset()
})

it.each([4120, 4999])('keeps native fallback selection for PID %s', async pid => {
  native.mockResolvedValue(rows)
  expect(await readProcessRows('win32', pid)).toEqual(rows.filter(row => row.pid === pid))
  expect(native).toHaveBeenCalledExactlyOnceWith(null)
})

it('keeps native read failure unknown for a selected PID', async () => {
  native.mockResolvedValue(null)
  expect(await readProcessRows('win32', 4120)).toBeNull()
})

it('widens selected native demand for a concurrent full census without a second read', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let complete!: (rows: ProcessRow[]) => void
  native.mockReturnValue(new Promise(resolve => { complete = resolve }))
  const selected = processRows(4120), full = processRows(), other = processRows(4121)
  complete(rows)
  expect(await selected).toEqual([rows[0]])
  expect(await full).toEqual(rows)
  expect(await other).toEqual([rows[1]])
  expect(native).toHaveBeenCalledOnce()
})
