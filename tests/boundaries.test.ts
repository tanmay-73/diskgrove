import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))
import { dialog, type BrowserWindow } from 'electron'
import { confirmFileAction } from '../src/main/confirm'
import { csvCell, escapeHtml } from '../src/main/export'
import { OperationGate } from '../src/main/operations'
import { asDeleteMode, asFormat, asPath, asPathList, asScanOptions, asSort } from '../src/main/validate'

describe('IPC arguments', () => {
  it('rejects relative, empty, NUL and oversized paths', () => {
    for (const input of ['', 'relative', 'x\0y', 'x'.repeat(32768), null, {}]) {
      expect(() => asPath(input)).toThrow()
    }
    expect(asPath(path.resolve('example'))).toBe(path.resolve('example'))
  })
  it('rejects unknown destructive modes, report formats and oversized batches', () => {
    expect(() => asDeleteMode('rm')).toThrow()
    expect(() => asFormat('exe')).toThrow()
    expect(() => asPathList([])).toThrow()
    expect(() => asPathList(Array(10001).fill(path.resolve('file')))).toThrow()
  })
  it('uses conservative defaults for malformed options', () => {
    expect(asScanOptions({ followLinks: 'true' })).toEqual({ followLinks: false, skipHidden: false })
    expect(asSort({ key: '__proto__', dir: 'sideways' })).toEqual({ key: 'size', dir: 'desc' })
  })
})

describe('report encoding', () => {
  it.each(['=1+1', '+cmd', '-1', '@SUM(A1)', '\tformula', '\rformula', '\nformula', '  =1', '\uFEFF=1'])(
    'neutralizes formula prefix in %j',
    (value) => expect(csvCell(value)).toBe(`"'${value}"`)
  )
  it('quotes CSV delimiters and escapes HTML metacharacters', () => {
    expect(csvCell('a,"b')).toBe('"a,""b"')
    expect(csvCell(42)).toBe('42')
    expect(escapeHtml('<script>"&\'</script>')).toBe('&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;')
  })
})

describe('native confirmation', () => {
  it.each(['open', 'trash', 'permanent'] as const)('defaults to cancel for %s', async (action) => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    expect(await confirmFileAction({} as BrowserWindow, ['/file\nmisleading name'], action)).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledWith({}, expect.objectContaining({ defaultId: 0, cancelId: 0 }))
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
    expect(await confirmFileAction({} as BrowserWindow, ['/file'], action)).toBe(true)
  })
})

it('rejects overlapping operations and unlocks after failure', async () => {
  const gate = new OperationGate()
  let release!: () => void
  const active = gate.run(
    'a scan',
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const work = vi.fn(async () => undefined)
  await expect(gate.run('deletion', work)).rejects.toThrow('a scan')
  expect(work).not.toHaveBeenCalled()
  release()
  await active
  await expect(
    gate.run('failure', async () => {
      throw new Error('test')
    })
  ).rejects.toThrow('test')
  await gate.run('next', work)
  expect(work).toHaveBeenCalledOnce()
})
